const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// === Configura tus credenciales de Google ===
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

// === Helpers ===
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// === Endpoint: Verificar estadoo ===
app.get('/health', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// === Endpoint: Listar carpetas ===
app.get('/folders', async (req, res) => {
  try {
    const result = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name, modifiedTime)',
    });
    res.json({ folders: result.data.files, total: result.data.files.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Endpoint: Listar archivos de una carpeta ===
app.get('/folder/:folderId/files', async (req, res) => {
  const folderId = req.params.folderId;
  const limit = req.query.limit || 20;

  try {
    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      pageSize: limit,
      fields: 'files(id, name, mimeType, modifiedTime, size)',
    });
    res.json({
      folder: { id: folderId },
      files: result.data.files,
      total: result.data.files.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Endpoint: Extraer texto de un archivo ===
app.get('/file/:fileId/text', async (req, res) => {
  const fileId = req.params.fileId;

  try {
    const file = await drive.files.get({ fileId, fields: 'name, mimeType' });
    const mime = file.data.mimeType;

    let buffer;
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    buffer = await streamToBuffer(response.data);

    let text = '';
    let type = '';

    if (mime === 'application/pdf') {
      const parsed = await pdfParse(buffer);
      text = parsed.text;
      type = 'pdf';
    } else if (mime === 'application/vnd.google-apps.document') {
      const doc = await drive.files.export(
        { fileId, mimeType: 'text/plain' },
        { responseType: 'stream' }
      );
      const exportedBuffer = await streamToBuffer(doc.data);
      text = exportedBuffer.toString('utf-8');
      type = 'google-doc';
    } else if (mime === 'text/plain') {
      text = buffer.toString('utf-8');
      type = 'txt';
    } else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      type = 'docx';
    } else if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      workbook.SheetNames.forEach(sheetName => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
        text += `--- Sheet: ${sheetName} ---\n` + csv + '\n';
      });
      type = 'xlsx';
    } else {
      return res.status(415).json({ error: `Tipo de archivo no soportado: ${mime}` });
    }

    res.json({
      file: { name: file.data.name, id: fileId },
      type,
      text,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Inicializa el servidor ===
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
