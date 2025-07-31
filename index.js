const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Usar secrets de Replit
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || (process.env.REPL_URL ? `${process.env.REPL_URL}/callback` : 'http://localhost:3000/callback');

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Almacenamiento temporal de tokens (en producción usar DB)
let storedTokens = null;

app.get('/', (req, res) => {
  res.send(`
    <h1>Google Drive GPT Bridge</h1>
    <p><a href="/auth">Autenticar con Google Drive</a></p>
    <p><a href="/test">Probar conexión</a></p>
    <p><strong>Status:</strong> ${storedTokens ? 'Autenticado ✓' : 'No autenticado ✗'}</p>
    <p><small>Servidor activo - Auto-ping habilitado</small></p>
  `);
});

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
    access_type: 'offline'
  });
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  try {
    console.log('Callback recibido:', req.query);
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).send('No se recibió código de autorización');
    }
    
    const { tokens } = await oauth2Client.getToken(code);
    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);
    
    console.log('Tokens guardados exitosamente');
    
    res.send(`
      <h1>¡Autenticación exitosa!</h1>
      <p>Tokens guardados correctamente</p>
      <p><a href="/test">Probar listado de archivos</a></p>
      <p><a href="/">Volver al inicio</a></p>
      <script>
        // Auto-redirect después de 3 segundos
        setTimeout(() => {
          window.location.href = '/';
        }, 3000);
      </script>
    `);
  } catch (error) {
    console.error('Error en callback:', error);
    res.status(500).send(`
      <h1>Error en autenticación</h1>
      <p>${error.message}</p>
      <p><a href="/auth">Intentar de nuevo</a></p>
      <p><a href="/">Volver al inicio</a></p>
    `);
  }
});

// Listar carpetas
app.get('/folders', async (req, res) => {
  try {
    if (!storedTokens) {
      return res.status(401).json({ 
        error: 'No autenticado. Ve a /auth primero',
        auth_url: `${req.protocol}://${req.get('host')}/auth`
      });
    }
    
    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder'",
      pageSize: 50,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name'
    });
    
    res.json({
      folders: response.data.files,
      total: response.data.files.length
    });
  } catch (error) {
    console.error('Error listando carpetas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar archivos en una carpeta específica
app.get('/folder/:folderId/files', async (req, res) => {
  try {
    if (!storedTokens) {
      return res.status(401).json({ 
        error: 'No autenticado. Ve a /auth primero',
        auth_url: `${req.protocol}://${req.get('host')}/auth`
      });
    }
    
    const { folderId } = req.params;
    const { limit = 20 } = req.query;
    
    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    // Primero obtener información de la carpeta
    const folderInfo = await drive.files.get({
      fileId: folderId,
      fields: 'id, name'
    });
    
    // Luego obtener archivos de la carpeta
    const response = await drive.files.list({
      q: `'${folderId}' in parents`,
      pageSize: parseInt(limit),
      fields: 'files(id, name, mimeType, modifiedTime, size)',
      orderBy: 'modifiedTime desc'
    });
    
    res.json({
      folder: folderInfo.data,
      files: response.data.files,
      total: response.data.files.length
    });
  } catch (error) {
    console.error('Error listando archivos de carpeta:', error);
    res.status(500).json({ error: error.message });
  }
});

// Buscar carpetas por nombre
app.get('/search-folders', async (req, res) => {
  try {
    if (!storedTokens) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    
    const { q } = req.query;
    let query = "mimeType='application/vnd.google-apps.folder'";
    
    if (q) {
      query += ` and name contains '${q}'`;
    }
    
    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    const response = await drive.files.list({
      q: query,
      pageSize: 20,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name'
    });
    
    res.json({
      folders: response.data.files,
      search_query: q,
      total: response.data.files.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/files', async (req, res) => {
  try {
    if (!storedTokens) {
      return res.status(401).json({ 
        error: 'No autenticado. Ve a /auth primero',
        auth_url: `${req.protocol}://${req.get('host')}/auth`
      });
    }
    
    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    const response = await drive.files.list({
      q: req.query.query || '',
      pageSize: parseInt(req.query.limit) || 10,
      fields: 'files(id, name, mimeType, modifiedTime, size)',
      orderBy: 'modifiedTime desc'
    });
    
    res.json({
      files: response.data.files,
      total: response.data.files.length,
      query: req.query.query || 'todos los archivos'
    });
  } catch (error) {
    console.error('Error listando archivos:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/search', async (req, res) => {
  try {
    if (!storedTokens) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    
    const { q, type, folder } = req.query;
    let query = '';
    
    if (q) query += `name contains '${q}'`;
    if (type) {
      if (query) query += ' and ';
      query += `mimeType contains '${type}'`;
    }
    if (folder) {
      if (query) query += ' and ';
      query += `'${folder}' in parents`;
    }
    
    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    const response = await drive.files.list({
      q: query,
      pageSize: 20,
      fields: 'files(id, name, mimeType, modifiedTime)',
      orderBy: 'relevance desc'
    });
    
    res.json({
      files: response.data.files,
      search_query: q,
      type_filter: type,
      folder_filter: folder
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test', async (req, res) => {
  try {
    const response = await fetch(`${req.protocol}://${req.get('host')}/files`);
    const data = await response.json();
    
    let html = `
      <h1>Prueba de conexión</h1>
      <h2>Configuración:</h2>
      <p>CLIENT_ID: ${CLIENT_ID ? 'Configurado ✓' : 'Falta ✗'}</p>
      <p>CLIENT_SECRET: ${CLIENT_SECRET ? 'Configurado ✓' : 'Falta ✗'}</p>
      <p>REDIRECT_URI: ${REDIRECT_URI}</p>
      <h2>Respuesta de API:</h2>
      <pre>${JSON.stringify(data, null, 2)}</pre>
      <p><a href="/">Volver al inicio</a></p>
    `;
    
    res.send(html);
  } catch (error) {
    res.send(`<h1>Error</h1><p>${error.message}</p><p><a href="/">Volver</a></p>`);
  }
});

// Endpoint de salud para el auto-ping
app.get('/health', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Mantener el servidor activo con auto-ping
const keepAlive = () => {
  setInterval(() => {
    if (process.env.REPL_URL) {
      fetch(`${process.env.REPL_URL}/health`)
        .then(() => console.log('Auto-ping exitoso'))
        .catch(() => console.log('Auto-ping falló')); 
    }
  }, 4 * 60 * 1000); // Cada 4 minutos
};

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor corriendo en puerto ${port}`);
  console.log(`CLIENT_ID configurado: ${!!CLIENT_ID}`);
  console.log(`CLIENT_SECRET configurado: ${!!CLIENT_SECRET}`);
  console.log(`REDIRECT_URI: ${REDIRECT_URI}`);
  
  // Solo activar auto-ping en Replit
  if (process.env.REPL_URL) {
    keepAlive();
    console.log('Auto-ping activado para mantener servidor despierto');
  }
});
