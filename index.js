const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:3000/callback`;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
let storedTokens = null;

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Página raíz: autenticación
app.get('/', (req, res) => {
  res.send(`
    <h1>Alico Documents Assistant</h1>
    <p><a href="/auth">🔐 Autenticarse con Google</a></p>
    <p><a href="/folders">📁 Ver carpetas</a></p>
    <p><a href="/test">⚙️ Probar conexión</a></p>
    <p><strong>Estado:</strong> ${storedTokens ? 'Autenticado ✅' : 'No autenticado ❌'}</p>
  `);
});

// Autenticación con Google
app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
    access_type: 'offline',
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Código de autorización faltante');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);
    res.send(`
      <h2>✅ Autenticado con éxito</h2>
      <p><a href="/">Volver al inicio</a></p>
      <script>setTimeout(() => window.location.href = '/', 2000)</script>
    `);
  } catch (err) {
    res.status(500).send(`Error autenticando: ${err.message}`);
  }
});

// Listar carpetas
app.get('/folders', async (req, res) => {
  if (!storedTokens) return res.status(401).json({ error: 'No autenticado' });

  oauth2Client.setCredentials(storedTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name'
    });
    res.json({ folders: response.data.files, total: response.data.files.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar carpeta por nombre
app.get('/search-folders', async (req, res) => {
  if (!storedTokens) return res.status(401).json({ error: 'No autenticado' });
  const { q } = req.query;

  oauth2Client.setCredentials(storedTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    const query = `mimeType='application/vnd.google-apps.folder' and name contains '${q}' and trashed=false`;
    const result = await drive.files.list({
      q: query,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name'
    });
    res.json({ folders: result.data.files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar archivos en carpeta
app.get('/folder/:folderId/files', async (req, res) => {
  const folderId = req.params.folderId;
  const limit = parseInt(req.query.limit) || 20;

  if (!storedTokens) return res.status(401).json({ error: 'No autenticado' });

  oauth2Client.setCredentials(storedTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, modifiedTime, size)',
      pageSize: limit
    });

    res.json({ folder: { id: folderId }, files: result.data.files, total: result.data.files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extraer texto del archivo
app.get('/file/:fileId/text', async (req, res) => {
  const fileId = req.params.fileId;

  if (!storedTokens) return res.status(401).json({ error: 'No autenticado' });

  oauth2Client.setCredentials(storedTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    const file = await drive.files.get({ fileId, fields: 'name, mimeType' });
    const mime = file.data.mimeType;

    const media = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    const buffer = await streamToBuffer(media.data);

    let text = '', type = '';
    if (mime === 'application/pdf') {
      const parsed = await pdfParse(buffer);
      text = parsed.text;
      type = 'pdf';
    } else if (mime === 'text/plain') {
      text = buffer.toString('utf-8');
      type = 'txt';
    } else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      type = 'docx';
    } else if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      workbook.SheetNames.forEach(sheet => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
        text += `--- Hoja: ${sheet} ---\n${csv}\n`;
      });
      type = 'xlsx';
    } else if (mime === 'application/vnd.google-apps.document') {
      const exported = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'stream' });
      const exportedBuffer = await streamToBuffer(exported.data);
      text = exportedBuffer.toString('utf-8');
      type = 'google-doc';
    } else {
      return res.status(415).json({ error: `Tipo de archivo no soportado: ${mime}` });
    }

    res.json({ file: { name: file.data.name, id: fileId }, type, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Búsqueda por nombre o tipo
app.get('/search', async (req, res) => {
  if (!storedTokens) return res.status(401).json({ error: 'No autenticado' });

  const { q, type, folder } = req.query;
  let query = '';

  if (q) query += `name contains '${q}'`;
  if (type) query += `${query ? ' and ' : ''}mimeType contains '${type}'`;
  if (folder) query += `${query ? ' and ' : ''}'${folder}' in parents`;

  oauth2Client.setCredentials(storedTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    const result = await drive.files.list({
      q: query,
      fields: 'files(id, name, mimeType, modifiedTime)',
      orderBy: 'relevance desc'
    });
    res.json({ files: result.data.files, search_query: q, type_filter: type, folder_filter: folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prueba visual
app.get('/test', async (req, res) => {
  if (!storedTokens) {
    return res.send('<h3>🔒 No autenticado</h3><a href="/auth">Autenticarse</a>');
  }

  const response = await fetch(`http://localhost:${port}/folders`);
  const data = await response.json();

  res.send(`
    <h2>🧪 Prueba de conexión</h2>
    <pre>${JSON.stringify(data, null, 2)}</pre>
    <p><a href="/">Volver</a></p>
  `);
});

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Auto ping
const keepAlive = () => {
  setInterval(() => {
    if (process.env.REPL_URL) {
      fetch(`${process.env.REPL_URL}/health`)
        .then(() => console.log('Auto-ping exitoso'))
        .catch(() => console.log('Auto-ping fallido'));
    }
  }, 4 * 60 * 1000);
};

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
  if (process.env.REPL_URL) keepAlive();
});
