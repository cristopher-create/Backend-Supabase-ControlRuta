// app.js

// 1. Importar módulos necesarios
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';

// Nota: Asegúrate de tener "type": "module" en tu package.json para usar 'import'
import dotenv from 'dotenv';
dotenv.config();

// 2. Inicializar Express
const app = express();
const port = process.env.PORT || 3000;

// 3. Middlewares
app.use(cors());
app.use(bodyParser.json());

// 4. Variables de Configuración para SQLite Cloud Weblite
const SQLITE_CLOUD_BASE_URL = 'https://cawalewunz.g6.sqlite.cloud:443';
const SQLITE_CLOUD_SQL_ENDPOINT = '/v2/weblite/sql';
const SQLITE_CLOUD_DB_NAME = 'RutaFlores57';

// En .env solo guardas la API key pura
const SQLITE_CLOUD_API_KEY = process.env.SQLITE_CLOUD_API_KEY;

// Connection string para el header Authorization (formato Weblite)
const SQLITE_CLOUD_AUTH =
  `sqlitecloud://cawalewunz.g6.sqlite.cloud:8860?apikey=${SQLITE_CLOUD_API_KEY}`;

if (!SQLITE_CLOUD_API_KEY) {
  console.error('ERROR: La variable de entorno SQLITE_CLOUD_API_KEY no está definida.');
  console.error('Por favor, crea un archivo .env con SQLITE_CLOUD_API_KEY=TU_API_KEY');
  process.exit(1);
}

// Helper simple para escapar comillas simples en SQL y evitar inyecciones básicas
function sqlEscape(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/'/g, "''");
}

// 5. Ruta de prueba
app.get('/', (req, res) => {
  res.send('Backend de login, sync y registro funcionando.');
});

// 6. Endpoint de Login
app.post('/login', async (req, res) => {
  const { idInspector, password } = req.body;

  if (!idInspector || !password) {
    return res.status(400).json({
      success: false,
      message: 'Por favor, proporcione ID de Inspector y contraseña.',
    });
  }

  // Seleccionar idInspector, codeInsp y nombre
  const sqlQuery = `
    SELECT idInspector, codeInsp, nombre
    FROM Inspectores
    WHERE idInspector = '${sqlEscape(idInspector)}'
      AND contraseña = '${sqlEscape(password)}';
  `;

  console.log(`Intentando autenticar idInspector: ${idInspector}`);

  try {
    const response = await axios.post(
      `${SQLITE_CLOUD_BASE_URL}${SQLITE_CLOUD_SQL_ENDPOINT}`,
      {
        database: SQLITE_CLOUD_DB_NAME,
        sql: sqlQuery,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${SQLITE_CLOUD_AUTH}`,
        },
      }
    );

    const data = response.data?.data;

    let rows = [];
    if (Array.isArray(data)) {
      rows = data;
    } else if (data && typeof data === 'object') {
      rows = [data];
    }

    if (response.status === 200 && rows.length > 0) {
      let inspectorData = {};

      if (Array.isArray(rows[0])) {
        // Caso: array de valores en orden [idInspector, codeInsp, nombre]
        inspectorData = {
          idInspector: rows[0][0],
          codeInsp: rows[0][1],
          nombre: rows[0][2],
        };
      } else {
        // Caso: objeto { idInspector, codeInsp, nombre }
        inspectorData = rows[0];
      }

      console.log(`Login exitoso para idInspector: ${idInspector}`);

      return res.status(200).json({
        success: true,
        message: 'Login exitoso.',
        inspector: inspectorData,
      });
    } else {
      console.log(
        `Login fallido para idInspector: ${idInspector} - Credenciales incorrectas.`
      );
      return res.status(401).json({
        success: false,
        message: 'ID de Inspector o contraseña incorrectos.',
      });
    }
  } catch (error) {
    console.error('Error al comunicarse con SQLite Cloud (login):', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error de conexión o autenticación.',
    });
  }
});

// 7. Endpoint de sincronización de UN informe
app.post('/sync-report', async (req, res) => {
  const { report } = req.body;

  if (!report) {
    return res.status(400).json({
      success: false,
      message: 'Falta el objeto "report" en el cuerpo de la petición.',
    });
  }

  try {
    const cantidad = Number(report.cantidad) || 0;
    const falta = report.falta ?? 'N/A';

    // 1) INSERT sencillo en reports
    const sqlInsertReport = `
      INSERT INTO reports (
        local_id, fecha, hora, padron, lugar, operador, sentido,
        tipo_incidencia, falta, cantidad, lugar_bajada_final, hora_bajada_final,
        inspector_cod, inspector_name, full_text, created_at, synced_at, sync_status
      ) VALUES (
        NULL,
        '${sqlEscape(report.fecha)}', '${sqlEscape(report.hora)}', '${sqlEscape(report.padron)}',
        '${sqlEscape(report.lugar)}', '${sqlEscape(report.operador)}', '${sqlEscape(report.sentido)}',
        '${sqlEscape(report.tipoIncidencia)}', '${sqlEscape(falta)}', ${cantidad},
        ${report.lugarBajadaFinal ? `'${sqlEscape(report.lugarBajadaFinal)}'` : 'NULL'},
        ${report.horaBajadaFinal ? `'${sqlEscape(report.horaBajadaFinal)}'` : 'NULL'},
        ${report.inspectorCod ? `'${sqlEscape(report.inspectorCod)}'` : 'NULL'},
        ${report.inspectorName ? `'${sqlEscape(report.inspectorName)}'` : 'NULL'},
        '${sqlEscape(report.fullText ?? '')}',
        datetime('now'), datetime('now'), 'synced'
      );
    `;

    const insertReportResp = await axios.post(
      `${SQLITE_CLOUD_BASE_URL}${SQLITE_CLOUD_SQL_ENDPOINT}`,
      { database: SQLITE_CLOUD_DB_NAME, sql: sqlInsertReport },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${SQLITE_CLOUD_AUTH}`,
        },
      }
    );

    if (insertReportResp.status !== 200) {
      console.error('Error al insertar en reports:', insertReportResp.data);
      throw new Error('Fallo insert report');
    }

    // 2) Obtener el último id con SELECT MAX(id)
    const sqlGetId = `SELECT MAX(id) AS id FROM reports;`;

    const getIdResp = await axios.post(
      `${SQLITE_CLOUD_BASE_URL}${SQLITE_CLOUD_SQL_ENDPOINT}`,
      { database: SQLITE_CLOUD_DB_NAME, sql: sqlGetId },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${SQLITE_CLOUD_AUTH}`,
        },
      }
    );

    let reportId = null;
    const idData = getIdResp.data?.data;

    if (Array.isArray(idData) && idData.length > 0) {
      const row = idData[0];
      if (row) {
        // Puede venir como objeto {id: 123} o array [123]
        reportId = typeof row === 'object' && !Array.isArray(row) ? (row.id || row.ID) : row[0];
        reportId = Number(reportId);
      }
    } else if (idData && typeof idData === 'object') {
      reportId = Number(idData.id ?? idData.ID) || null;
    }

    if (!reportId) {
      console.error('No se obtuvo ID del reporte (MAX(id)).', JSON.stringify(getIdResp.data));
      throw new Error('No se obtuvo ID del reporte');
    }

    // 3) Construir SQL para tablas hijas
    const sqlLines = [];

    // Usuarios
    if (Array.isArray(report.usuariosAdicionales)) {
      for (const user of report.usuariosAdicionales) {
        const dinero = Number(user.dinero) || 0;
        sqlLines.push(
          `INSERT INTO report_users (report_id, dinero, lugar_subida, lugar_bajada)
           VALUES (${reportId}, ${dinero}, '${sqlEscape(user.lugarSubida)}', '${sqlEscape(user.lugarBajada)}');`
        );
      }
    }

    // Observaciones
    if (Array.isArray(report.observaciones)) {
      report.observaciones.forEach((obs, index) => {
        sqlLines.push(
          `INSERT INTO report_observations (report_id, obs_index, texto)
           VALUES (${reportId}, ${index}, '${sqlEscape(obs)}');`
        );
      });
    }

    // Reintegros
    if (Array.isArray(report.reintegradoMontos)) {
      report.reintegradoMontos.forEach((raw, idx) => {
        const monto = Number(raw) || 0;
        sqlLines.push(
          `INSERT INTO report_reintegros (report_id, reintegro_index, monto, raw_text)
           VALUES (${reportId}, ${idx + 1}, ${monto}, '${sqlEscape(raw)}');`
        );
      });
    }

    // Boletos marcados
    if (report.boletosMarcados && typeof report.boletosMarcados === 'object') {
      for (const [tarifa, numeros] of Object.entries(report.boletosMarcados)) {
        if (Array.isArray(numeros)) {
          for (const n of numeros) {
            sqlLines.push(
              `INSERT INTO report_ticket_marked (report_id, tarifa, numero)
               VALUES (${reportId}, '${sqlEscape(tarifa)}', ${Number(n) || 0});`
            );
          }
        }
      }
    }

    // Rangos
    if (report.rangoBoletos && typeof report.rangoBoletos === 'object') {
      for (const [tarifa, rango] of Object.entries(report.rangoBoletos)) {
        if (rango && typeof rango === 'object') {
          sqlLines.push(
            `INSERT INTO report_ticket_ranges (report_id, tarifa, min_numero, max_numero)
             VALUES (${reportId}, '${sqlEscape(tarifa)}', ${Number(rango.min) || 0}, ${Number(rango.max) || 0});`
          );
        }
      }
    }

    // Ejecutar inserciones hijas en transacción
    if (sqlLines.length > 0) {
      const fullChildrenSql = `BEGIN;\n${sqlLines.join('\n')}\nCOMMIT;`;

      const insertChildrenResp = await axios.post(
        `${SQLITE_CLOUD_BASE_URL}${SQLITE_CLOUD_SQL_ENDPOINT}`,
        { database: SQLITE_CLOUD_DB_NAME, sql: fullChildrenSql },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${SQLITE_CLOUD_AUTH}`,
          },
        }
      );

      if (insertChildrenResp.status !== 200) {
        console.error('Error al insertar datos hijos:', insertChildrenResp.data);
        throw new Error('Fallo insert hijos');
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Informe sincronizado correctamente.',
      remoteId: reportId,
    });
  } catch (error) {
    console.error('Error en /sync-report:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error interno al sincronizar el informe.',
      error: error.message,
    });
  }
});

// 8. Endpoint actualizado para registrar nuevo inspector
app.post('/register', async (req, res) => {
  const { nombre, apellido, codigo, fechaNac, paradero, contraseña, idInspector } = req.body;

  // Usar idInspector generado desde Flutter si existe, o fallback a codigo
  const inspectorId = idInspector && idInspector.trim() !== '' ? idInspector.trim() : codigo;

  // Validación de campos obligatorios
  if (!nombre || !apellido || !codigo || !fechaNac || !paradero || !contraseña || !inspectorId) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos obligatorios para el registro.',
    });
  }

  // Chequeo de duplicado por idInspector
  const sqlCheck = `
    SELECT idInspector FROM Inspectores WHERE idInspector = '${sqlEscape(inspectorId)}';
  `;

  try {
    const checkResp = await axios.post(
      `${SQLITE_CLOUD_BASE_URL}${SQLITE_CLOUD_SQL_ENDPOINT}`,
      { database: SQLITE_CLOUD_DB_NAME, sql: sqlCheck },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${SQLITE_CLOUD_AUTH}`,
        },
      }
    );
    if (checkResp.data?.data && Array.isArray(checkResp.data.data) && checkResp.data.data.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Este ID de inspector ya está registrado.',
      });
    }
  } catch (e) {
    console.error('Error en consulta de duplicado (register):', e.message);
    // Si la consulta de duplicado falla, sigue con la inserción.
  }

  // SQL Insert en Inspectores (usa el inspectorId generado como PK y codigo como codeInsp)
  const sqlInsert = `
    INSERT INTO Inspectores (
      idInspector,
      codeInsp,
      nombre,
      apellido,
      paradero,
      fechaRegistro,
      contraseña,
      fechaNac
    ) VALUES (
      '${sqlEscape(inspectorId)}',
      '${sqlEscape(codigo)}',
      '${sqlEscape(nombre)}',
      '${sqlEscape(apellido)}',
      '${sqlEscape(paradero)}',
      datetime('now'),
      '${sqlEscape(contraseña)}',
      '${sqlEscape(fechaNac)}'
    );
  `;

  try {
    const insertResp = await axios.post(
      `${SQLITE_CLOUD_BASE_URL}${SQLITE_CLOUD_SQL_ENDPOINT}`,
      { database: SQLITE_CLOUD_DB_NAME, sql: sqlInsert },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${SQLITE_CLOUD_AUTH}`,
        },
      }
    );

    if (insertResp.status === 200) {
      return res.status(201).json({
        success: true,
        message: 'Inspector registrado exitosamente.',
      });
    } else {
      console.error('Error al insertar nuevo inspector:', insertResp.data);
      return res.status(500).json({
        success: false,
        message: 'Error en el registro en base de datos.',
        dbData: insertResp.data,
      });
    }
  } catch (error) {
    console.error('Error inesperado al registrar inspector:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error inesperado al registrar inspector.',
      error: error.message,
      dbData: error.response?.data,
    });
  }
});

// ==================================================================
// 🚨 PEGAR ESTO ANTES DE "app.listen"
// Nuevo Endpoint para que FLUTTER WEB descargue las estadísticas
// ==================================================================

app.get('/get-reports', async (req, res) => {
  // 1. La consulta SQL para traer los datos
  const sqlQuery = `
    SELECT 
      id, 
      fecha, 
      hora, 
      padron, 
      operador, 
      tipo_incidencia, 
      falta, 
      cantidad, 
      inspector_name, 
      local_id 
    FROM reports 
    ORDER BY created_at DESC 
    LIMIT 500;
  `;

  console.log('Solicitud recibida en /get-reports');

  try {
    // 2. Pedir los datos a SQLite Cloud
    const response = await axios.post(
      `${SQLITE_CLOUD_BASE_URL}${SQLITE_CLOUD_SQL_ENDPOINT}`,
      {
        database: SQLITE_CLOUD_DB_NAME,
        sql: sqlQuery,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${SQLITE_CLOUD_AUTH}`,
        },
      }
    );

    const data = response.data?.data;
    
    // 3. Normalizar la respuesta (asegurar que sea un array)
    let rows = [];
    if (Array.isArray(data)) {
        rows = data; 
    } else if (data && typeof data === 'object') {
        rows = [data];
    }

    console.log(`Enviando ${rows.length} reportes al dashboard.`);

    // 4. Responder a Flutter
    return res.status(200).json({
      success: true,
      count: rows.length,
      reports: rows,
    });

  } catch (error) {
    console.error('Error al obtener reportes:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error al leer la base de datos.',
      error: error.message,
    });
  }
});

// ==================================================================
// FIN DEL CÓDIGO NUEVO
// ==================================================================

// 9. Iniciar el servidor Express
app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
  console.log(`Login:            POST http://localhost:${port}/login`);
  console.log(`Sync report:      POST http://localhost:${port}/sync-report`);
  console.log(`Register insp:    POST http://localhost:${port}/register`);
});