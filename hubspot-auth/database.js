const { Pool } = require("pg")
const { loadConfig } = require("./config")

const config = loadConfig()

const pool = new Pool({
  connectionString: config.database.url,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

pool.on("connect", () => {
  console.log("✅ Conectado ao PostgreSQL")
})

pool.on("error", (err) => {
  console.error("❌ Erro na conexão PostgreSQL:", err)
})

async function saveOrUpdateToken({ hubId, refreshToken, accessToken, expiresAt, createdAt, updatedAt }) {
  if (!hubId || !refreshToken || !accessToken || !expiresAt) {
    throw new Error("Parâmetros obrigatórios faltando")
  }

  const client = await pool.connect()

  try {
    const query = `
      INSERT INTO conector_hubspot (
        hub_id, refresh_token, access_token, expires_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (hub_id) 
      DO UPDATE SET 
        refresh_token = EXCLUDED.refresh_token,
        access_token = EXCLUDED.access_token,
        expires_at = EXCLUDED.expires_at,
        updated_at = EXCLUDED.updated_at
      RETURNING *;
    `

    const result = await client.query(query, [hubId, refreshToken, accessToken, expiresAt, createdAt, updatedAt])
    console.log("✅ Token salvo/atualizado:", result.rows[0])
    return result.rows[0]
  } catch (err) {
    console.error("❌ Erro ao salvar token:", err)
    throw err
  } finally {
    client.release()
  }
}

async function getTokenByHubId(hubId) {
  const client = await pool.connect()

  try {
    const query = "SELECT * FROM conector_hubspot WHERE hub_id = $1"
    const result = await client.query(query, [hubId])
    return result.rows[0] || null
  } catch (err) {
    console.error("❌ Erro ao buscar token:", err)
    throw err
  } finally {
    client.release()
  }
}

async function isTokenExpired(hubId) {
  const tokenData = await getTokenByHubId(hubId)
  if (!tokenData) return true

  return new Date() >= new Date(tokenData.expires_at)
}

async function refreshAccessToken(hubId) {
  const tokenData = await getTokenByHubId(hubId)
  if (!tokenData) {
    throw new Error("Token não encontrado para este hub")
  }

  try {
    const axios = require("axios")
    const response = await axios.post("https://api.hubapi.com/oauth/v1/token", null, {
      params: {
        grant_type: "refresh_token",
        client_id: config.hubspot.clientId,
        client_secret: config.hubspot.clientSecret,
        refresh_token: tokenData.refresh_token,
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    })

    const { access_token, expires_in, refresh_token } = response.data

    const now = new Date()
    const expiresAt = new Date(now.getTime() + expires_in * 1000)

    await saveOrUpdateToken({
      hubId,
      refreshToken: refresh_token || tokenData.refresh_token,
      accessToken: access_token,
      expiresAt,
      createdAt: tokenData.created_at,
      updatedAt: now,
    })

    return access_token
  } catch (err) {
    console.error("❌ Erro ao renovar token:", err.response?.data || err.message)
    throw err
  }
}

module.exports = {
  saveOrUpdateToken,
  getTokenByHubId,
  isTokenExpired,
  refreshAccessToken,
  pool,
}
