// app.js

// 1. FIX IPv4 (Vital para que conecte a Supabase)
import './ipv4fix.js'; 

import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import pg from 'pg'; 
import dotenv from 'dotenv';

dotenv.config();

const app = express();
// NO CAMBIES ESTO. Render usa el puerto 10000 internamente.
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Verificación de seguridad
if (!process.env.DATABASE_URL) {
  console.error('ERROR: La variable de entorno DATABASE_URL no está definida.');
  process.exit(1);
}

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// === HELPER 1: Escapar comillas (Seguridad) ===
function sqlEscape(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/'/g, "''");
}

// === HELPER 2: TRADUCTOR DE FECHAS (Vital para Postgres) ===
// Convierte "04/10/2001" (Flutter) -> "2001-10-04" (Postgres)
// Convierte "" -> NULL
function cleanDate(value) {
  if (!value || value.trim() === '') return 'NULL';
  
  // Si ya viene como YYYY-MM-DD, lo dejamos pasar
  if (value.match(/^\d{4}-\d{2}-\d{2}/)) return `'${value}'`;

  // Si viene como DD/MM/YYYY (Tu caso en Flutter)
  const parts = value.split('/');
  if (parts.length === 3) {
    // parts[0] = dia, parts[1] = mes, parts[2] = año
    return `'${parts[2]}-${parts[1]}-${parts[0]}'`;
  }
  
  return 'NULL'; 
}

// === HELPER 3: TRADUCTOR DE HORAS ===
function cleanTime(value) {
  if (!value || value.trim() === '') return 'NULL';
  return `'${sqlEscape(value)}'`;
}

// === HELPER 4: LIMPIEZA DE TEXTO ===
function cleanText(value) {
  if (!value || value.trim() === '') return 'NULL';
  return `'${sqlEscape(value)}'`;
}

// --- RUTAS ---

app.get('/', (req, res) => {
  res.send('Backend Supabase (PostgreSQL) con traductor de fechas ACTIVO.');
});

// Endpoint de Login
app.post('/login', async (req, res) => {
  const { idInspector, password } = req.body;

  if (!idInspector || !password) {
    return res.status(400).json({ success: false, message: 'Faltan credenciales.' });
  }

  // Usamos comillas dobles en las columnas porque así las creaste en Supabase
  const sqlQuery = `
    SELECT "idInspector", "codeInsp", nombre
    FROM public.inspectores
    WHERE "idInspector" = '${sqlEscape(idInspector)}'
      AND "contraseña" = '${sqlEscape(password)}';
  `;

  try {
    const result = await pool.query(sqlQuery);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return res.status(200).json({
        success: true,
        message: 'Login exitoso.',
        inspector: {
          idInspector: row.idInspector,
          codeInsp: row.codeInsp,
          nombre: row.nombre,
        },
      });
    } else {
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas.' });
    }
  } catch (error) {
    console.error('Error Login:', error.message);
    return res.status(500).json({ success: false, message: 'Error de conexión o autenticación.', error: error.message });
  }
});

// Endpoint de Registro (AQUÍ USAMOS EL TRADUCTOR DE FECHAS)
app.post('/register', async (req, res) => {
  const { nombre, apellido, codigo, fechaNac, paradero, contraseña, idInspector } = req.body;
  const inspectorId = idInspector && idInspector.trim() !== '' ? idInspector.trim() : codigo;

  try {
    // Chequeo duplicado
    const check = await pool.query(`SELECT "idInspector" FROM public.inspectores WHERE "idInspector" = '${sqlEscape(inspectorId)}'`);
    if (check.rows.length > 0) return res.status(409).json({ success: false, message: 'ID ya registrado.' });

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
        ${cleanDate(fechaNac)} 
      );
    `;
    // Nota: cleanDate ya pone las comillas necesarias, no las pongas tú.

    await pool.query(sqlInsert);
    return res.status(201).json({ success: true, message: 'Registrado.' });

  } catch (error) {
    console.error('Error Registro:', error.message);
    return res.status(500).json({ success: false, message: 'Error en base de datos.', error: error.message });
  }
});

// Endpoint Sync Report (TAMBIÉN ACTUALIZADO CON TRADUCTORES)
app.post('/sync-report', async (req, res) => {
  const { report } = req.body;
  if (!report) return res.status(400).json({ success: false, message: 'Falta report.' });

  const client = await pool.connect();

  try {
    const cantidad = Number(report.cantidad) || 0;
    const falta = report.falta ?? 'N/A';

    // Usamos los helpers para limpiar fechas y horas
    const sqlInsertReport = `
      INSERT INTO public.reports (
        local_id, fecha, hora, padron, lugar, operador, sentido,
        tipo_incidencia, falta, cantidad, lugar_bajada_final, hora_bajada_final,
        inspector_cod, inspector_name, full_text, created_at, synced_at, sync_status
      ) VALUES (
        NULL,
        ${cleanDate(report.fecha)}, 
        ${cleanTime(report.hora)}, 
        ${cleanText(report.padron)},
        ${cleanText(report.lugar)}, 
        ${cleanText(report.operador)}, 
        ${cleanText(report.sentido)},
        ${cleanText(report.tipoIncidencia)}, 
        ${cleanText(falta)}, 
        ${cantidad},
        ${cleanText(report.lugarBajadaFinal)},
        ${cleanTime(report.horaBajadaFinal)},
        ${cleanText(report.inspectorCod)},
        ${cleanText(report.inspectorName)},
        ${cleanText(report.fullText)},
        NOW(), NOW(), 'synced'
      ) RETURNING id;
    `;

    const resInsert = await client.query(sqlInsertReport);
    const reportId = resInsert.rows[0].id;

    // Inserciones Hijas
    const sqlLines = [];
    if (Array.isArray(report.usuariosAdicionales)) {
      for (const user of report.usuariosAdicionales) {
        // Dinero usa Number() y Text usa sqlEscape()
        sqlLines.push(`INSERT INTO public.report_users (report_id, dinero, lugar_subida, lugar_bajada) VALUES (${reportId}, ${Number(user.dinero)||0}, '${sqlEscape(user.lugarSubida)}', '${sqlEscape(user.lugarBajada)}');`);
      }
    }
    if (Array.isArray(report.observaciones)) {
      report.observaciones.forEach((obs, index) => {
        sqlLines.push(`INSERT INTO public.report_observations (report_id, obs_index, texto) VALUES (${reportId}, ${index}, '${sqlEscape(obs)}');`);
      });
    }
    if (Array.isArray(report.reintegradoMontos)) {
      report.reintegradoMontos.forEach((raw, idx) => {
        sqlLines.push(`INSERT INTO public.report_reintegros (report_id, reintegro_index, monto, raw_text) VALUES (${reportId}, ${idx + 1}, ${Number(raw)||0}, '${sqlEscape(raw)}');`);
      });
    }
    if (report.boletosMarcados && typeof report.boletosMarcados === 'object') {
      for (const [tarifa, numeros] of Object.entries(report.boletosMarcados)) {
        if (Array.isArray(numeros)) {
          for (const n of numeros) {
            sqlLines.push(`INSERT INTO public.report_ticket_marked (report_id, tarifa, numero) VALUES (${reportId}, '${sqlEscape(tarifa)}', ${Number(n) || 0});`);
          }
        }
      }
    }
    if (report.rangoBoletos && typeof report.rangoBoletos === 'object') {
      for (const [tarifa, rango] of Object.entries(report.rangoBoletos)) {
        if (rango && typeof rango === 'object') {
          sqlLines.push(`INSERT INTO public.report_ticket_ranges (report_id, tarifa, min_numero, max_numero) VALUES (${reportId}, '${sqlEscape(tarifa)}', ${Number(rango.min) || 0}, ${Number(rango.max) || 0});`);
        }
      }
    }
    
    if (sqlLines.length > 0) {
      await client.query(`BEGIN; ${sqlLines.join(' ')} COMMIT;`);
    }

    return res.status(200).json({ success: true, message: 'Sincronizado.', remoteId: reportId });

  } catch (error) {
    console.error('Error Sync:', error.message);
    if (client) await client.query('ROLLBACK'); 
    return res.status(500).json({ success: false, message: 'Error interno.', error: error.message });
  } finally {
    client.release();
  }
});

app.get('/get-reports', async (req, res) => {
  const sqlQuery = `SELECT id, fecha, hora, padron, operador, tipo_incidencia, falta, cantidad, inspector_name, local_id FROM public.reports ORDER BY created_at DESC LIMIT 500;`;
  try {
    const result = await pool.query(sqlQuery);
    return res.status(200).json({ success: true, count: result.rows.length, reports: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error DB', error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Backend Postgres (v2.0 con Traductor) escuchando en puerto ${port}`);
});