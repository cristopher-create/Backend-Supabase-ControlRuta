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

// Helper simple para escapar comillas simples en SQL
function sqlEscape(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/'/g, "''");
}

// 5. Ruta de prueba
app.get('/', (req, res) => {
  res.send('Backend de login y sync funcionando.');
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
        inspectorData = {
          idInspector: rows[0][0],
          codeInsp: rows[0][1],
          nombre: rows[0][2],
        };
      } else {
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
    if (error.response) {
      console.error(
        'Respuesta SQLite Cloud status (login):',
        error.response.status
      );
      console.error(
        'Respuesta SQLite Cloud data (login):',
        error.response.data
      );
    }
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

    // 1) INSERT + SELECT last_insert_rowid() en la misma llamada
    const sqlInsertAndGetId = `
      BEGIN;
      INSERT INTO reports (
        local_id, fecha, hora, padron, lugar, operador, sentido,
        tipo_incidencia, falta, cantidad, lugar_bajada_final, hora_bajada_final,
        inspector_cod, inspector_name, full_text, created_at, synced_at, sync_status
      ) VALUES (
        NULL,
        '${sqlEscape(report.fecha)}', '${sqlEscape(report.hora)}', '${sqlEscape(
          report.padron
        )}',
        '${sqlEscape(report.lugar)}', '${sqlEscape(
          report.operador
        )}', '${sqlEscape(report.sentido)}',
        '${sqlEscape(report.tipoIncidencia)}', '${sqlEscape(falta)}', ${cantidad},
        ${
          report.lugarBajadaFinal
            ? `'${sqlEscape(report.lugarBajadaFinal)}'`
            : 'NULL'
        },
        ${
          report.horaBajadaFinal
            ? `'${sqlEscape(report.horaBajadaFinal)}'`
            : 'NULL'
        },
        ${
          report.inspectorCod
            ? `'${sqlEscape(report.inspectorCod)}'`
            : 'NULL'
        },
        ${
          report.inspectorName
            ? `'${sqlEscape(report.inspectorName)}'`
            : 'NULL'
        },
        '${sqlEscape(report.fullText ?? '')}',
        datetime('now'), datetime('now'), 'synced'
      );
      SELECT last_insert_rowid() AS id;
      COMMIT;
    `;

    const insertReportResp = await axios.post(
      `${SQLITE_CLOUD_BASE_URL}${SQLITE_CLOUD_SQL_ENDPOINT}`,
      { database: SQLITE_CLOUD_DB_NAME, sql: sqlInsertAndGetId },
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

    const data = insertReportResp.data?.data;
    let reportId = null;

    // Helper para extraer el id de un resultset Weblite (columns + rows)
    function extractIdFromResult(result) {
      if (!result || typeof result !== 'object') return null;

      // Caso típico: { columns: [...], rows: [[id]] }
      if (Array.isArray(result.rows) && result.rows.length > 0) {
        const firstRow = result.rows[0];
        if (Array.isArray(firstRow) && firstRow.length > 0) {
          return Number(firstRow[0]) || null;
        }
      }

      // Por si devolviera { id: 42 } u otros campos similares
      if (
        result.id !== undefined ||
        result.ID !== undefined ||
        result.rowId !== undefined ||
        result.rowid !== undefined
      ) {
        return Number(
          result.id ?? result.ID ?? result.rowId ?? result.rowid
        ) || null;
      }

      return null;
    }

    if (Array.isArray(data)) {
      const lastResult = data[data.length - 1];
      reportId = extractIdFromResult(lastResult);
    } else if (data && typeof data === 'object') {
      reportId = extractIdFromResult(data);
    }

    if (!reportId) {
      console.error(
        'No se obtuvo ID del reporte. Respuesta completa de Weblite:',
        JSON.stringify(insertReportResp.data, null, 2)
      );
      throw new Error('No se obtuvo ID del reporte');
    }

    // 2) Construir SQL para tablas hijas
    const sqlLines = [];

    // Usuarios
    if (Array.isArray(report.usuariosAdicionales)) {
      for (const user of report.usuariosAdicionales) {
        const dinero = Number(user.dinero) || 0;
        sqlLines.push(
          `INSERT INTO report_users (report_id, dinero, lugar_subida, lugar_bajada)
           VALUES (${reportId}, ${dinero}, '${sqlEscape(
             user.lugarSubida
           )}', '${sqlEscape(user.lugarBajada)}');`
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
             VALUES (${reportId}, '${sqlEscape(tarifa)}', ${
              Number(rango.min) || 0
            }, ${Number(rango.max) || 0});`
          );
        }
      }
    }

    // Ejecutar inserciones hijas en transacción
    if (sqlLines.length > 0) {
      const fullChildrenSql = `BEGIN;\n${sqlLines.join('\n')}\nCOMMIT;`;

      console.log('SQL hijos (usuarios/obs/reintegros/boletos/rangos):');
      console.log(fullChildrenSql);

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
        console.error('Error al insertar datos hijos del reporte:', insertChildrenResp.data);
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

    if (error.response) {
      console.error(
        'Respuesta SQLite Cloud status (sync):',
        error.response.status
      );
      console.error(
        'Respuesta SQLite Cloud data (sync):',
        error.response.data
      );

      return res.status(500).json({
        success: false,
        message: 'Error de SQLite Cloud al sincronizar el informe.',
        dbError: error.response.data,
      });
    }

    if (error.request) {
      console.error('No se recibió respuesta de SQLite Cloud (sync):', error.request);
      return res.status(500).json({
        success: false,
        message: 'No se pudo conectar con el servicio de base de datos.',
      });
    }

    console.error('Error inesperado en /sync-report:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error inesperado al sincronizar el informe.',
      error: error.message,
    });
  }
});

// 8. Iniciar el servidor Express
app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
  console.log(`Login:        POST http://localhost:${port}/login`);
  console.log(`Sync report:  POST http://localhost:${port}/sync-report`);
});
