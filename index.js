const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const pdf = require('pdf-parse');
const stream = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || (process.env.REPL_URL ? `${process.env.REPL_URL}/callback` : 'http://localhost:3000/callback');

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
let storedTokens = null;

// Página de inicio
app.get('/', (req, res) => {
  res.send(`
    <h1>Google Drive GPT Bridge</h1>
    <p><a href="/auth">Autenticar con Google Drive</a></p>
    <p><a href="/test">Probar conexión</a></p>
    <p><strong>Status:</strong> ${storedTokens ? 'Autenticado ✓' : 'No autenticado ✗'}</p>
  `);
});

// Autenticación OAuth
app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    scope: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/documents.readonly'],
    access_type: 'offline'
  });
  res.redirect(authUrl);
});

// Callback de autenticación
app.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('No se recibió código de autorización');
    const { tokens } = await oauth2Client.getToken(code);
    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);
    res.send(`<h1>¡Autenticación exitosa!</h1><p>Tokens guardados correctamente</p><script>setTimeout(() => { window.location.href = '/' }, 3000);</script>`);
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

// Listar archivos dentro de una carpeta
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

// Buscar archivos con mapeo de tipo MIME
app.get('/search', async (req, res) => {
  try {
    if (!storedTokens) return res.status(401).json({ error: 'No autenticado' });

    const { q, type, folder } = req.query;
    let queryParts = [];

    const mimeTypes = {
      pdf: 'application/pdf',
      doc: 'application/vnd.google-apps.document',
      sheet: 'application/vnd.google-apps.spreadsheet',
      slide: 'application/vnd.google-apps.presentation',
      folder: 'application/vnd.google-apps.folder'
    };

    if (q) queryParts.push(`name contains '${q}'`);
    if (type) {
      const resolvedType = mimeTypes[type] || type;
      queryParts.push(`mimeType='${resolvedType}'`);
    }
    if (folder) queryParts.push(`'${folder}' in parents`);

    const finalQuery = queryParts.join(' and ');
    oauth2Client.setCredentials(storedTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.list({
      q: finalQuery,
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

// Descargar contenido de archivo
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

// Obtener texto de PDF o Google Docs
app.get('/file/:fileId/text', async (req, res) => {
  try {
    if (!storedTokens) return notAuthenticated(res, req);
    const { fileId } = req.params;
    oauth2Client.setCredentials(storedTokens);

    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const docs = google.docs({ version: 'v1', auth: oauth2Client });

    const file = await drive.files.get({ fileId, fields: 'id, name, mimeType' });

    if (file.data.mimeType === 'application/pdf') {
      const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
      const buffer = await streamToBuffer(response.data);
      const data = await pdf(buffer);
      return res.json({
        file: { name: file.data.name, id: file.data.id },
        type: 'pdf',
        text: data.text
      });
    }

    if (file.data.mimeType === 'application/vnd.google-apps.document') {
      const doc = await docs.documents.get({ documentId: fileId });
      const text = doc.data.body.content
        .map(e => e.paragraph?.elements?.map(el => el.textRun?.content || '').join('') || '')
        .join('');
      return res.json({
        file: { name: file.data.name, id: file.data.id },
        type: 'google-doc',
        text: text
      });
    }

    return res.status(415).json({ error: 'Tipo de archivo no soportado para extracción de texto.' });
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

// Prueba de conexión
app.get('/test', async (req, res) => {
  try {
    const response = await fetch(`${req.protocol}://${req.get('host')}/folders`);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: 'Respuesta no es JSON', body: text };
    }
    res.send(`<pre>${JSON.stringify(data, null, 2)}</pre>`);
  } catch (error) {
    res.send(`<h1>Error</h1><p>${error.message}</p>`);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Helper para autenticación no válida
function notAuthenticated(res, req) {
  return res.status(401).json({
    error: 'No autenticado. Ve a /auth primero',
    auth_url: `${req.protocol}://${req.get('host')}/auth`
  });
}

// Keep-alive para Replit o Render
const keepAlive = () => {
  setInterval(() => {
    if (process.env.REPL_URL) {
      fetch(`${process.env.REPL_URL}/health`)
        .then(() => console.log('Auto-ping exitoso'))
        .catch(() => console.log('Auto-ping falló'));
    }
  }, 4 * 60 * 1000);
};

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor corriendo en puerto ${port}`);
  if (process.env.REPL_URL) keepAlive();
});
