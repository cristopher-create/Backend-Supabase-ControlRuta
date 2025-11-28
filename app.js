// app.js


import './ipv4fix.js';
// 1. Importar módulos necesarios
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import pg from 'pg'; // CAMBIO: Usamos 'pg' en lugar de 'axios'

import dotenv from 'dotenv';
dotenv.config();

// 2. Inicializar Express
const app = express();
const port = process.env.PORT || 3000;

// 3. Middlewares
app.use(cors());
app.use(bodyParser.json());

// 4. Configuración de conexión a SUPABASE (PostgreSQL)
const { Pool } = pg;

// Verificación de seguridad
if (!process.env.DATABASE_URL) {
  console.error('ERROR: La variable de entorno DATABASE_URL no está definida.');
  process.exit(1);
}

// Creamos el pool de conexiones
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necesario para que Render conecte con Supabase sin errores de SSL
  }
});

// Helper para escapar comillas simples (Igual que antes, funciona en Postgres)
function sqlEscape(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/'/g, "''");
}

// 5. Ruta de prueba
app.get('/', (req, res) => {
  res.send('Backend conectado a Supabase (PostgreSQL) funcionando.');
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

  // NOTA: En Postgres los nombres de columnas con mayúsculas deben ir entre comillas dobles si se crearon así.
  // Ajusté la consulta para usar comillas dobles en "idInspector", etc.
  const sqlQuery = `
    SELECT "idInspector", "codeInsp", nombre
    FROM public.inspectores
    WHERE "idInspector" = '${sqlEscape(idInspector)}'
      AND "contraseña" = '${sqlEscape(password)}';
  `;

  console.log(`Intentando autenticar idInspector: ${idInspector}`);

  try {
    // CAMBIO: Ejecutar query directo a Postgres
    const result = await pool.query(sqlQuery);
    const rows = result.rows;

    if (rows.length > 0) {
      const row = rows[0];
      
      // Mapeamos los datos para que Flutter los reciba igual que antes
      const inspectorData = {
        idInspector: row.idInspector,
        codeInsp: row.codeInsp,
        nombre: row.nombre,
      };

      console.log(`Login exitoso para idInspector: ${idInspector}`);

      return res.status(200).json({
        success: true,
        message: 'Login exitoso.',
        inspector: inspectorData,
      });
    } else {
      console.log(`Login fallido para idInspector: ${idInspector}`);
      return res.status(401).json({
        success: false,
        message: 'ID de Inspector o contraseña incorrectos.',
      });
    }
  } catch (error) {
    console.error('Error en Supabase (login):', error.message);
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

  // Usamos un cliente del pool para manejar transacciones si fuera necesario
  const client = await pool.connect();

  try {
    const cantidad = Number(report.cantidad) || 0;
    const falta = report.falta ?? 'N/A';

    // CAMBIO IMPORTANTE: Postgres usa NOW() en vez de datetime('now')
    // CAMBIO IMPORTANTE: Usamos 'RETURNING id' para obtener el ID inmediatamente (más seguro que SELECT MAX)
    
    const sqlInsertReport = `
      INSERT INTO public.reports (
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
        NOW(), NOW(), 'synced'
      ) RETURNING id;
    `;

    // Ejecutamos el insert y obtenemos el ID al mismo tiempo
    const resInsert = await client.query(sqlInsertReport);
    const reportId = resInsert.rows[0].id; // ¡Aquí tenemos el ID!

    if (!reportId) {
      throw new Error('No se obtuvo ID del reporte al insertar.');
    }

    // 3) Construir SQL para tablas hijas
    // Postgres permite ejecutar múltiples inserts separados por ; en una sola llamada
    const sqlLines = [];

    // Usuarios
    if (Array.isArray(report.usuariosAdicionales)) {
      for (const user of report.usuariosAdicionales) {
        const dinero = Number(user.dinero) || 0;
        sqlLines.push(
          `INSERT INTO public.report_users (report_id, dinero, lugar_subida, lugar_bajada)
           VALUES (${reportId}, ${dinero}, '${sqlEscape(user.lugarSubida)}', '${sqlEscape(user.lugarBajada)}');`
        );
      }
    }

    // Observaciones
    if (Array.isArray(report.observaciones)) {
      report.observaciones.forEach((obs, index) => {
        sqlLines.push(
          `INSERT INTO public.report_observations (report_id, obs_index, texto)
           VALUES (${reportId}, ${index}, '${sqlEscape(obs)}');`
        );
      });
    }

    // Reintegros
    if (Array.isArray(report.reintegradoMontos)) {
      report.reintegradoMontos.forEach((raw, idx) => {
        const monto = Number(raw) || 0;
        sqlLines.push(
          `INSERT INTO public.report_reintegros (report_id, reintegro_index, monto, raw_text)
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
              `INSERT INTO public.report_ticket_marked (report_id, tarifa, numero)
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
            `INSERT INTO public.report_ticket_ranges (report_id, tarifa, min_numero, max_numero)
             VALUES (${reportId}, '${sqlEscape(tarifa)}', ${Number(rango.min) || 0}, ${Number(rango.max) || 0});`
          );
        }
      }
    }

    // Ejecutar inserciones hijas si existen
    if (sqlLines.length > 0) {
      // Envolvemos en transacción para seguridad
      const fullChildrenSql = `BEGIN; ${sqlLines.join(' ')} COMMIT;`;
      await client.query(fullChildrenSql);
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
  } finally {
    client.release(); // Importante: Liberar el cliente al pool
  }
});

// 8. Endpoint actualizado para registrar nuevo inspector
app.post('/register', async (req, res) => {
  const { nombre, apellido, codigo, fechaNac, paradero, contraseña, idInspector } = req.body;

  const inspectorId = idInspector && idInspector.trim() !== '' ? idInspector.trim() : codigo;

  if (!nombre || !apellido || !codigo || !fechaNac || !paradero || !contraseña || !inspectorId) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos obligatorios para el registro.',
    });
  }

  try {
    // Chequeo de duplicado
    const sqlCheck = `SELECT "idInspector" FROM public.inspectores WHERE "idInspector" = '${sqlEscape(inspectorId)}';`;
    const checkResult = await pool.query(sqlCheck);
    
    if (checkResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Este ID de inspector ya está registrado.',
      });
    }

    // SQL Insert (Usando NOW() en vez de datetime('now'))
    const sqlInsert = `
      INSERT INTO public.inspectores (
        "idInspector", "codeInsp", nombre, apellido, paradero, "fechaRegistro", "contraseña", "fechaNac"
      ) VALUES (
        '${sqlEscape(inspectorId)}',
        '${sqlEscape(codigo)}',
        '${sqlEscape(nombre)}',
        '${sqlEscape(apellido)}',
        '${sqlEscape(paradero)}',
        NOW(),
        '${sqlEscape(contraseña)}',
        '${sqlEscape(fechaNac)}'
      );
    `;

    await pool.query(sqlInsert);

    return res.status(201).json({
      success: true,
      message: 'Inspector registrado exitosamente.',
    });

  } catch (error) {
    console.error('Error al registrar inspector:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error en el registro en base de datos.',
      error: error.message
    });
  }
});

// Endpoint para el Dashboard Web (Flutter Web)
app.get('/get-reports', async (req, res) => {
  const sqlQuery = `
    SELECT id, fecha, hora, padron, operador, tipo_incidencia, falta, cantidad, inspector_name, local_id 
    FROM public.reports 
    ORDER BY created_at DESC 
    LIMIT 500;
  `;

  console.log('Solicitud recibida en /get-reports');

  try {
    const result = await pool.query(sqlQuery);
    const rows = result.rows;

    console.log(`Enviando ${rows.length} reportes al dashboard.`);

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

// 9. Iniciar el servidor
app.listen(port, () => {
  console.log(`Backend Supabase escuchando en http://localhost:${port}`);
});