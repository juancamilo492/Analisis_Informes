const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const pdf = require('pdf-parse');
const stream = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

// Usar secrets de Replit o entorno
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || (process.env.REPL_URL ? `${process.env.REPL_URL}/callback` : 'http://localhost:3000/callback');

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Almacenamiento temporal de tokens
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
    const { code } = req.query;
    if (!code) return res.status(400).send('No se recibió código de autorización');

    const { tokens } = await oauth2Client.getToken(code);
    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);

    res.send(`
      <h1>¡Autenticación exitosa!</h1>
      <p>Tokens guardados correctamente</p>
      <script>
        setTimeout(() => { window.location.href = '/' }, 3000);
      </script>
    `);
  } catch (error) {
    res.status(500).send(`<h1>Error en autenticación</h1><p>${error.message}</p>`);
  }
});

// Listar carpetas
app.get('/folders', async (req, res) => {
  try {
    if (!storedTokens) return notAuthenticated(res, req);
    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder'",
      pageSize: 50,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name'
    });

    res.json({ folders: response.data.files, total: response.data.files.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Listar archivos de una carpeta
app.get('/folder/:folderId/files', async (req, res) => {
  try {
    if (!storedTokens) return notAuthenticated(res, req);
    const { folderId } = req.params;
    const { limit = 20 } = req.query;

    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const folderInfo = await drive.files.get({ fileId: folderId, fields: 'id, name' });
    const response = await drive.files.list({
      q: `'${folderId}' in parents`,
      pageSize: parseInt(limit),
      fields: 'files(id, name, mimeType, modifiedTime, size)',
      orderBy: 'modifiedTime desc'
    });

    res.json({ folder: folderInfo.data, files: response.data.files, total: response.data.files.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar carpetas
app.get('/search-folders', async (req, res) => {
  try {
    if (!storedTokens) return res.status(401).json({ error: 'No autenticado' });

    const { q } = req.query;
    let query = "mimeType='application/vnd.google-apps.folder'";
    if (q) query += ` and name contains '${q}'`;

    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.list({
      q: query,
      pageSize: 20,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name'
    });

    res.json({ folders: response.data.files, search_query: q, total: response.data.files.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar archivos
app.get('/search', async (req, res) => {
  try {
    if (!storedTokens) return res.status(401).json({ error: 'No autenticado' });

    const { q, type, folder } = req.query;
    let query = '';
    if (q) query += `name contains '${q}'`;
    if (type) query += (query ? ' and ' : '') + `mimeType contains '${type}'`;
    if (folder) query += (query ? ' and ' : '') + `'${folder}' in parents`;

    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.list({
      q: query,
      pageSize: 20,
      fields: 'files(id, name, mimeType, modifiedTime)',
      orderBy: 'relevance desc'
    });

    res.json({ files: response.data.files, search_query: q, type_filter: type, folder_filter: folder });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Descargar archivo por ID
app.get('/file/:fileId/content', async (req, res) => {
  try {
    if (!storedTokens) return notAuthenticated(res, req);
    const { fileId } = req.params;

    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const file = await drive.files.get({ fileId, fields: 'id, name, mimeType' });
    const download = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

    res.setHeader('Content-Disposition', `attachment; filename="${file.data.name}"`);
    res.setHeader('Content-Type', file.data.mimeType);
    download.data.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Extraer texto de PDF
app.get('/file/:fileId/text', async (req, res) => {
  try {
    if (!storedTokens) return notAuthenticated(res, req);
    const { fileId } = req.params;

    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const file = await drive.files.get({ fileId, fields: 'id, name, mimeType' });
    if (file.data.mimeType !== 'application/pdf') {
      return res.status(400).json({ error: 'El archivo no es un PDF.' });
    }

    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    const buffer = await streamToBuffer(response.data);
    const data = await pdf(buffer);

    res.json({
      file: { name: file.data.name, id: file.data.id },
      text: data.text
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Utilidad: convertir stream en buffer
function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', chunk => chunks.push(chunk));
    readableStream.on('end', () => resolve(Buffer.concat(chunks)));
    readableStream.on('error', reject);
  });
}

// Test de conexión
app.get('/test', async (req, res) => {
  try {
    const response = await fetch(`${req.protocol}://${req.get('host')}/files`);
    const data = await response.json();
    res.send(`<pre>${JSON.stringify(data, null, 2)}</pre>`);
  } catch (error) {
    res.send(`<h1>Error</h1><p>${error.message}</p>`);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Mantener vivo (auto-ping)
const keepAlive = () => {
  setInterval(() => {
    if (process.env.REPL_URL) {
      fetch(`${process.env.REPL_URL}/health`)
        .then(() => console.log('Auto-ping exitoso'))
        .catch(() => console.log('Auto-ping falló'));
    }
  }, 4 * 60 * 1000);
};

// Helper para errores de autenticación
function notAuthenticated(res, req) {
  return res.status(401).json({
    error: 'No autenticado. Ve a /auth primero',
    auth_url: `${req.protocol}://${req.get('host')}/auth`
  });
}

// Iniciar servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor corriendo en puerto ${port}`);
  if (process.env.REPL_URL) {
    keepAlive();
  }
});
