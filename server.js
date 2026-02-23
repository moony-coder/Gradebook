const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const ExcelJS = require('exceljs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable if you need inline scripts
}));

// Compression
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to API routes
app.use('/api/', limiter);

// Middleware
app.use(cors({
  origin: isProduction ? process.env.ALLOWED_ORIGIN || '*' : '*',
  credentials: true
}));

app.use(bodyParser.json({ 
  limit: '10mb', // Reduced from 50mb
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf);
    } catch (e) {
      throw new Error('Invalid JSON');
    }
  }
}));

app.use(bodyParser.urlencoded({ 
  extended: true, 
  limit: '10mb' 
}));

// Request logging in development
if (!isProduction) {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });
}

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: isProduction ? '1d' : 0,
  etag: true
}));

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'GradeJournal backend running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Validate PDF input
function validateLessonData(data) {
  const errors = [];
  
  if (!data.className || typeof data.className !== 'string') {
    errors.push('Invalid or missing className');
  }
  
  if (!data.lessonName || typeof data.lessonName !== 'string') {
    errors.push('Invalid or missing lessonName');
  }
  
  if (!data.lessonDate || typeof data.lessonDate !== 'string') {
    errors.push('Invalid or missing lessonDate');
  }
  
  if (!Array.isArray(data.columns)) {
    errors.push('columns must be an array');
  }
  
  if (!Array.isArray(data.rows)) {
    errors.push('rows must be an array');
  }
  
  if (data.logoData && typeof data.logoData === 'string' && data.logoData.length > 1000000) {
    errors.push('Logo data too large (max 1MB)');
  }
  
  return errors;
}

function validateClassData(data) {
  const errors = [];
  
  if (!data.className || typeof data.className !== 'string') {
    errors.push('Invalid or missing className');
  }
  
  if (!Array.isArray(data.rows)) {
    errors.push('rows must be an array');
  }
  
  return errors;
}

// Generate PDF from lesson data
app.post('/api/export/pdf/lesson', async (req, res) => {
  let browser = null;
  
  try {
    const data = req.body;
    
    // Validate input
    const errors = validateLessonData(data);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Invalid input', details: errors });
    }
    
    console.log('Generating PDF for lesson:', data.lessonName);
    
    // Find Chrome executable path for production
    let executablePath = null;
    if (isProduction) {
      const chromePaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome'
      ];
      
      for (const path of chromePaths) {
        try {
          if (require('fs').existsSync(path)) {
            executablePath = path;
            break;
          }
        } catch (e) {
          // Ignore
        }
      }
    }
    
    // Launch browser with appropriate options
    browser = await puppeteer.launch({
      ...(executablePath && { executablePath }),
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process', // For Render
        '--no-zygote',
        '--disable-web-security' // Sometimes needed for local fonts
      ],
      timeout: 30000
    });

    const page = await browser.newPage();
    
    // Set timeout
    page.setDefaultTimeout(30000);
    
    // Generate HTML
    const html = generateLessonHTML(data);
    
    await page.setContent(html, { 
      waitUntil: ['load', 'networkidle0'],
      timeout: 30000 
    });
    
    await page.setViewport({ width: 1200, height: 800 });
    
    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        bottom: '20px',
        left: '20px',
        right: '20px'
      },
      preferCSSPageSize: true
    });
    
    await browser.close();
    
    // Send PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="GradeJournal-Lesson-${Date.now()}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('PDF generation error:', error);
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }
    
    // Don't expose internal errors to client
    const message = isProduction 
      ? 'PDF generation failed' 
      : error.message;
      
    res.status(500).json({ error: message });
  }
});

// Generate PDF from class data
app.post('/api/export/pdf/class', async (req, res) => {
  let browser = null;
  
  try {
    const data = req.body;
    
    // Validate input
    const errors = validateClassData(data);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Invalid input', details: errors });
    }
    
    console.log('Generating PDF for class:', data.className);
    
    // Find Chrome executable path for production
    let executablePath = null;
    if (isProduction) {
      const chromePaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome'
      ];
      
      for (const path of chromePaths) {
        try {
          if (require('fs').existsSync(path)) {
            executablePath = path;
            break;
          }
        } catch (e) {
          // Ignore
        }
      }
    }
    
    browser = await puppeteer.launch({
      ...(executablePath && { executablePath }),
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ],
      timeout: 30000
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    
    const html = generateClassHTML(data);
    
    await page.setContent(html, { 
      waitUntil: ['load', 'networkidle0'],
      timeout: 30000 
    });
    
    await page.setViewport({ width: 1200, height: 800 });
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        bottom: '20px',
        left: '20px',
        right: '20px'
      },
      preferCSSPageSize: true
    });
    
    await browser.close();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="GradeJournal-Class-${Date.now()}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('PDF generation error:', error);
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }
    
    const message = isProduction 
      ? 'PDF generation failed' 
      : error.message;
      
    res.status(500).json({ error: message });
  }
});

// Excel export endpoint
app.post('/api/export/excel', async (req, res) => {
  try {
    const data = req.body;
    
    if (!data.type || !['lesson', 'class'].includes(data.type)) {
      return res.status(400).json({ error: 'Invalid export type' });
    }
    
    const workbook = new ExcelJS.Workbook();
    
    workbook.creator = 'GradeJournal';
    workbook.lastModifiedBy = 'GradeJournal';
    workbook.created = new Date();
    workbook.modified = new Date();
    
    if (data.type === 'lesson') {
      // Validate lesson data
      if (!data.className || !data.lessonName || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
        return res.status(400).json({ error: 'Invalid lesson data' });
      }
      
      const worksheet = workbook.addWorksheet('Lesson Results');
      
      // Title
      worksheet.mergeCells('A1', `${String.fromCharCode(64 + data.columns.length + 2)}1`);
      worksheet.getCell('A1').value = `${data.className} — ${data.lessonName}`;
      worksheet.getCell('A1').font = { size: 16, bold: true, name: 'Arial' };
      
      // Date
      worksheet.mergeCells('A2', `${String.fromCharCode(64 + data.columns.length + 2)}2`);
      worksheet.getCell('A2').value = `Date: ${data.lessonDate || 'N/A'}`;
      worksheet.getCell('A2').font = { italic: true, color: { argb: '666666' }, name: 'Arial' };
      
      // Empty row
      worksheet.getRow(3).height = 10;
      
      // Headers
      const headerRow = worksheet.getRow(4);
      headerRow.getCell(1).value = 'Student';
      headerRow.getCell(2).value = 'Attendance';
      
      data.columns.forEach((col, index) => {
        headerRow.getCell(index + 3).value = col;
      });
      
      // Style headers
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFF' }, name: 'Arial', size: 11 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'C17F3A' }
        };
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
      
      // Data rows
      data.rows.forEach((row, index) => {
        const excelRow = worksheet.getRow(index + 5);
        excelRow.getCell(1).value = row.studentName || '';
        
        const attendance = row.attendance || 'present';
        excelRow.getCell(2).value = attendance.charAt(0).toUpperCase() + attendance.slice(1);
        
        (row.grades || []).forEach((grade, colIndex) => {
          excelRow.getCell(colIndex + 3).value = grade || '';
        });
        
        excelRow.eachCell((cell) => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
          };
          cell.alignment = { vertical: 'middle' };
        });
      });
      
      // Set column widths
      worksheet.columns.forEach((column, i) => {
        if (i === 0) column.width = 25;
        else if (i === 1) column.width = 15;
        else column.width = 15;
      });
      
      // Freeze header row
      worksheet.views = [
        { state: 'frozen', xSplit: 0, ySplit: 4 }
      ];
      
    } else {
      // Class export
      if (!data.className || !Array.isArray(data.rows)) {
        return res.status(400).json({ error: 'Invalid class data' });
      }
      
      const worksheet = workbook.addWorksheet('Class Roster');
      
      // Title
      worksheet.mergeCells('A1:E1');
      worksheet.getCell('A1').value = `${data.className} — Class Roster`;
      worksheet.getCell('A1').font = { size: 16, bold: true, name: 'Arial' };
      
      // Empty row
      worksheet.getRow(2).height = 10;
      
      // Headers
      const headerRow = worksheet.getRow(3);
      headerRow.getCell(1).value = 'Student';
      headerRow.getCell(2).value = 'Phone';
      headerRow.getCell(3).value = 'Email';
      headerRow.getCell(4).value = 'Parent/Guardian';
      headerRow.getCell(5).value = 'Attendance Rate';
      
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFF' }, name: 'Arial', size: 11 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'C17F3A' }
        };
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
      
      // Data rows
      data.rows.forEach((row, index) => {
        const excelRow = worksheet.getRow(index + 4);
        excelRow.getCell(1).value = row.name || '';
        excelRow.getCell(2).value = row.phone || '';
        excelRow.getCell(3).value = row.email || '';
        excelRow.getCell(4).value = row.parentName || '';
        excelRow.getCell(5).value = row.attendanceRate ? `${row.attendanceRate}%` : '';
        
        excelRow.eachCell((cell) => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
          };
          cell.alignment = { vertical: 'middle' };
        });
      });
      
      // Set column widths
      worksheet.getColumn(1).width = 25;
      worksheet.getColumn(2).width = 18;
      worksheet.getColumn(3).width = 25;
      worksheet.getColumn(4).width = 22;
      worksheet.getColumn(5).width = 18;
      
      worksheet.views = [
        { state: 'frozen', xSplit: 0, ySplit: 3 }
      ];
    }
    
    const buffer = await workbook.xlsx.writeBuffer();
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="GradeJournal-${data.type}-${Date.now()}.xlsx"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
    
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ error: 'Excel export failed' });
  }
});
// ============================================
// HTML TEMPLATES
// ============================================

function generateLessonHTML(data) {
  const accentColor = data.accentColor || '#C17F3A';
  
  const logoHtml = data.logoData 
    ? `<img src="${data.logoData}" alt="Logo" style="max-width:100%;max-height:100%;object-fit:contain;" loading="lazy">`
    : `<div style="width:100%;height:100%;background:linear-gradient(135deg, ${accentColor}, ${accentColor}dd);border-radius:12px;display:flex;align-items:center;justify-content:center;color:white;font-size:32px;font-weight:800;">GJ</div>`;
  
  const presentCount = data.rows.filter(r => r.attendance === 'present').length;
  const lateCount = data.rows.filter(r => r.attendance === 'late').length;
  const absentCount = data.rows.filter(r => r.attendance === 'absent').length;
  const attendedCount = presentCount + lateCount;
  const attendanceRate = data.rows.length > 0 
    ? Math.round((attendedCount / data.rows.length) * 100) 
    : 100;
  
  const tableHeaders = data.columns.map(col => `<th>${escapeHtml(col)}</th>`).join('');
  
  const tableRows = data.rows.map(row => {
    const initials = (row.studentName || '').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const attendanceClass = row.attendance === 'present' ? 'present' : row.attendance === 'late' ? 'late' : 'absent';
    
    const gradesHtml = (row.grades || []).map(g => {
      if (g && g.toString().match(/^\d+(\.\d)?$/)) {
        const bandClass = `band-${Math.floor(parseFloat(g))}`;
        return `<td class="grade-cell ${bandClass}">${escapeHtml(g)}</td>`;
      }
      return `<td class="grade-cell">${escapeHtml(g) || '—'}</td>`;
    }).join('');
    
    return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:32px;height:32px;background:${accentColor}15;border-radius:8px;display:flex;align-items:center;justify-content:center;color:${accentColor};font-weight:700;font-size:12px;">${escapeHtml(initials)}</div>
            <span style="font-weight:600;">${escapeHtml(row.studentName || '')}</span>
          </div>
        </td>
        <td>
          <span class="attendance-badge ${attendanceClass}">
            ${row.attendance === 'present' ? '✓' : row.attendance === 'late' ? '⏰' : '✗'}
            ${row.attendance ? (row.attendance.charAt(0).toUpperCase() + row.attendance.slice(1)) : 'Present'}
          </span>
        </td>
        ${gradesHtml}
      </tr>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Lesson Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #FAF7F2;
      color: #2C2416;
      padding: 40px;
      position: relative;
    }
    .bg-accent {
      position: fixed;
      top: -100px;
      right: -100px;
      width: 400px;
      height: 400px;
      background: ${accentColor};
      opacity: 0.03;
      border-radius: 50%;
      z-index: -1;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 30px;
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 2px solid ${accentColor}20;
    }
    .logo-container {
      width: 100px;
      height: 100px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 12px ${accentColor}20;
      padding: 10px;
      flex-shrink: 0;
    }
    .title-section { flex: 1; }
    .title-section h1 {
      font-size: 28px;
      font-weight: 700;
      color: #2C2416;
      margin-bottom: 8px;
      font-family: 'Playfair Display', serif;
    }
    .subtitle {
      font-size: 16px;
      color: #A08060;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background: ${accentColor}15;
      color: ${accentColor};
      border-radius: 100px;
      font-size: 13px;
      font-weight: 600;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
      margin-bottom: 40px;
    }
    .stat-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #EDE4D5;
      box-shadow: 0 2px 8px rgba(0,0,0,0.02);
    }
    .stat-label {
      font-size: 12px;
      color: #A08060;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
      color: #2C2416;
    }
    .stat-value small {
      font-size: 14px;
      font-weight: 400;
      color: #A08060;
      margin-left: 8px;
    }
    .table-container {
      background: white;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid #EDE4D5;
      box-shadow: 0 4px 12px rgba(0,0,0,0.03);
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      background: ${accentColor};
      color: white;
      font-weight: 600;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 16px 20px;
      text-align: left;
    }
    td {
      padding: 14px 20px;
      border-bottom: 1px solid #EDE4D5;
    }
    tr:last-child td { border-bottom: none; }
    tbody tr:nth-child(even) { background: #FAF7F2; }
    tbody tr:hover { background: ${accentColor}10; }
    .attendance-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 14px;
      border-radius: 100px;
      font-size: 12px;
      font-weight: 600;
    }
    .attendance-badge.present { background: #EAF3EA; color: #2E7D32; }
    .attendance-badge.late { background: #FDF0DC; color: #B87020; }
    .attendance-badge.absent { background: #FAE8E8; color: #C04040; }
    .grade-cell { font-weight: 500; text-align: center; }
    .band-9 { color: #10b981; font-weight: 700; }
    .band-8 { color: #34d399; font-weight: 700; }
    .band-7 { color: #fbbf24; font-weight: 700; }
    .band-6 { color: #fb923c; font-weight: 700; }
    .band-5 { color: #f87171; font-weight: 700; }
    .band-low { color: #ef4444; font-weight: 700; }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #EDE4D5;
      text-align: center;
      color: #A08060;
      font-size: 12px;
    }
    @media print {
      body { padding: 20px; }
      .bg-accent { display: none; }
    }
  </style>
</head>
<body>
  <div class="bg-accent"></div>
  
  <div class="header">
    <div class="logo-container">${logoHtml}</div>
    <div class="title-section">
      <h1>Lesson Report: ${escapeHtml(data.lessonName || '')}</h1>
      <div class="subtitle">
        <span>${escapeHtml(data.className || '')}</span>
        <span class="badge">📅 ${escapeHtml(data.lessonDate || '')}</span>
      </div>
    </div>
  </div>
  
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Total Students</div>
      <div class="stat-value">${data.rows.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Attendance Rate</div>
      <div class="stat-value">${attendanceRate}% <small>(${attendedCount}/${data.rows.length})</small></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Present / Late</div>
      <div class="stat-value">${presentCount} / ${lateCount}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Absent</div>
      <div class="stat-value">${absentCount}</div>
    </div>
  </div>
  
  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Student</th>
          <th>Attendance</th>
          ${tableHeaders}
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>
  
  <div class="footer">
    Generated by GradeJournal Professional — ${escapeHtml(data.institutionName || 'GradeJournal')} • ${new Date().toLocaleDateString()}
  </div>
</body>
</html>
  `;
}

function generateClassHTML(data) {
  const accentColor = data.accentColor || '#C17F3A';
  
  const logoHtml = data.logoData 
    ? `<img src="${data.logoData}" alt="Logo" style="max-width:100%;max-height:100%;object-fit:contain;" loading="lazy">`
    : `<div style="width:100%;height:100%;background:linear-gradient(135deg, ${accentColor}, ${accentColor}dd);border-radius:12px;display:flex;align-items:center;justify-content:center;color:white;font-size:32px;font-weight:800;">GJ</div>`;
  
  const avgAttendance = data.rows.length > 0
    ? Math.round(data.rows.reduce((sum, r) => sum + (r.attendanceRate || 0), 0) / data.rows.length)
    : 0;
  
  const tableRows = data.rows.map(row => {
    const initials = (row.name || '').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const rateClass = row.attendanceRate >= 80 ? 'high' : row.attendanceRate >= 50 ? 'medium' : 'low';
    
    return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:32px;height:32px;background:${accentColor}15;border-radius:8px;display:flex;align-items:center;justify-content:center;color:${accentColor};font-weight:700;">${escapeHtml(initials)}</div>
            <span style="font-weight:600;">${escapeHtml(row.name || '')}</span>
          </div>
        </td>
        <td>${escapeHtml(row.phone) || '—'}</td>
        <td>${escapeHtml(row.email) || '—'}</td>
        <td>${escapeHtml(row.parentName) || '—'}</td>
        <td>
          <span style="display:inline-block;padding:4px 12px;border-radius:20px;font-weight:600;font-size:12px;background:${rateClass === 'high' ? '#EAF3EA' : rateClass === 'medium' ? '#FDF0DC' : '#FAE8E8'};color:${rateClass === 'high' ? '#2E7D32' : rateClass === 'medium' ? '#B87020' : '#C04040'};">
            ${row.attendanceRate || 0}%
          </span>
        </td>
      </tr>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Class Roster</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #FAF7F2;
      color: #2C2416;
      padding: 40px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 30px;
      margin-bottom: 40px;
      padding: 20px;
      background: white;
      border-radius: 16px;
      border: 1px solid #EDE4D5;
      box-shadow: 0 4px 12px rgba(0,0,0,0.03);
    }
    .logo-container {
      width: 80px;
      height: 80px;
      background: white;
      border-radius: 12px;
      padding: 8px;
      flex-shrink: 0;
    }
    .title-section { flex: 1; }
    .title-section h1 {
      font-size: 24px;
      font-weight: 700;
      color: #2C2416;
      margin-bottom: 4px;
      font-family: 'Playfair Display', serif;
    }
    .class-meta {
      font-size: 14px;
      color: #A08060;
      display: flex;
      gap: 20px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #EDE4D5;
      text-align: center;
    }
    .stat-number {
      font-size: 32px;
      font-weight: 700;
      color: ${accentColor};
      margin-bottom: 4px;
    }
    .stat-label {
      font-size: 12px;
      color: #A08060;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .table-container {
      background: white;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid #EDE4D5;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      background: ${accentColor};
      color: white;
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      padding: 16px 20px;
      text-align: left;
    }
    td {
      padding: 14px 20px;
      border-bottom: 1px solid #EDE4D5;
    }
    tr:last-child td { border-bottom: none; }
    tbody tr:nth-child(even) { background: #FAF7F2; }
    .footer {
      margin-top: 30px;
      text-align: center;
      color: #A08060;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-container">${logoHtml}</div>
    <div class="title-section">
      <h1>${escapeHtml(data.className || '')}</h1>
      <div class="class-meta">
        <span>👤 ${escapeHtml(data.teacherName || 'Teacher')}</span>
        <span>📚 ${escapeHtml(data.subject || 'Class')}</span>
        <span>📅 Generated ${new Date().toLocaleDateString()}</span>
      </div>
    </div>
  </div>
  
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-number">${data.rows.length}</div>
      <div class="stat-label">Total Students</div>
    </div>
    <div class="stat-card">
      <div class="stat-number">${data.totalLessons || 0}</div>
      <div class="stat-label">Lessons</div>
    </div>
    <div class="stat-card">
      <div class="stat-number">${avgAttendance}%</div>
      <div class="stat-label">Avg Attendance</div>
    </div>
  </div>
  
  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Student</th>
          <th>Phone</th>
          <th>Email</th>
          <th>Parent/Guardian</th>
          <th>Attendance Rate</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>
  
  <div class="footer">
    Generated by GradeJournal Professional
  </div>
</body>
</html>
  `;
}

// Helper function to escape HTML
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  
  res.status(500).json({ 
    error: 'Internal server error',
    message: isProduction ? 'Something went wrong' : err.message 
  });
});

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    // Serve index.html for SPA routes
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`✅ GradeJournal server running on port ${PORT}`);
  console.log(`📄 PDF exports with Puppeteer ready`);
  console.log(`📊 Excel exports with ExcelJS ready`);
  console.log(`🔒 Rate limiting enabled (100 requests per 15 minutes)`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌍 Open http://localhost:${PORT} to view the app`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;