const http = require("http")
const url = require("url")
const querystring = require("querystring")
const { Pool } = require("pg")

// Configuração do banco de dados
const pool = new Pool({
  connectionString:
    "{{url banco}}",
})

// Função para fazer requisições HTTP
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = require(options.protocol === "https:" ? "https" : "http").request(options, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        try {
          resolve({
            statusCode: res.statusCode,
            data: res.headers["content-type"]?.includes("application/json") ? JSON.parse(data) : data,
          })
        } catch (error) {
          resolve({ statusCode: res.statusCode, data })
        }
      })
    })

    req.on("error", reject)

    if (postData) {
      req.write(postData)
    }

    req.end()
  })
}

// Função para validar e renovar token
async function validateAndRefreshToken(hubId) {
  try {
    const result = await pool.query(
      "SELECT access_token, refresh_token, expires_at FROM conector_hubspot WHERE hub_id = $1",
      [hubId],
    )

    if (result.rows.length === 0) {
      return { valid: false, error: "Hub ID não encontrado" }
    }

    const { access_token, refresh_token, expires_at } = result.rows[0]
    const now = new Date()
    const expiresAt = new Date(expires_at)

    // Se o token ainda é válido
    if (expiresAt > now) {
      return { valid: true, token: access_token }
    }

    // Token expirado, tentar renovar
    if (!refresh_token) {
      return { valid: false, error: "Token expirado e sem refresh token" }
    }

    const refreshOptions = {
      hostname: "api.hubapi.com",
      port: 443,
      path: "/oauth/v1/token",
      method: "POST",
      protocol: "https:",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }

    const refreshData = querystring.stringify({
      grant_type: "refresh_token",
      refresh_token: refresh_token,
      client_id: process.env.HUBSPOT_CLIENT_ID || "your_client_id",
      client_secret: process.env.HUBSPOT_CLIENT_SECRET || "your_client_secret",
    })

    const refreshResponse = await makeRequest(refreshOptions, refreshData)

    if (refreshResponse.statusCode === 200) {
      const tokenData = refreshResponse.data
      const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000)

      // Atualizar token no banco
      await pool.query(
        "UPDATE conector_hubspot SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE hub_id = $4",
        [tokenData.access_token, tokenData.refresh_token || refresh_token, newExpiresAt, hubId],
      )

      return { valid: true, token: tokenData.access_token }
    } else {
      return { valid: false, error: "Falha ao renovar token" }
    }
  } catch (error) {
    console.error("Erro ao validar token:", error)
    return { valid: false, error: "Erro interno" }
  }
}

// Função para buscar usuários do HubSpot
async function getHubSpotUsers(accessToken) {
  const options = {
    hostname: "api.hubapi.com",
    port: 443,
    path: "/settings/v3/users",
    method: "GET",
    protocol: "https:",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  }

  try {
    const response = await makeRequest(options)

    if (response.statusCode === 200) {
      return { success: true, users: response.data.results || [] }
    } else {
      return { success: false, error: "Falha ao buscar usuários" }
    }
  } catch (error) {
    console.error("Erro ao buscar usuários:", error)
    return { success: false, error: "Erro na requisição" }
  }
}

// Servidor HTTP
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true)
  const path = parsedUrl.pathname
  const query = parsedUrl.query

  // Headers CORS
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

  if (req.method === "OPTIONS") {
    res.writeHead(200)
    res.end()
    return
  }

  try {
    // Rota para salvar credenciais iniciais
    if (path === "/api/save-credentials" && req.method === "POST") {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", async () => {
        try {
          const { token, clientId, accessToken, refreshToken, expiresIn } = JSON.parse(body)

          const hubId = `hub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          const expiresAt = new Date(Date.now() + expiresIn * 1000)

          await pool.query(
            `INSERT INTO conector_hubspot (hub_id, token_sonax, client_id_sonax, access_token, refresh_token, expires_at, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (hub_id) DO UPDATE SET 
             token_sonax = $2, client_id_sonax = $3, access_token = $4, refresh_token = $5, expires_at = $6`,
            [hubId, token, clientId, accessToken, refreshToken, expiresAt],
          )

          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: true, hubId }))
        } catch (error) {
          console.error("Erro ao salvar credenciais:", error)
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: false, error: "Erro interno" }))
        }
      })
    }

    // Rota para validar hub_id e buscar usuários
    else if (path === "/api/get-users" && req.method === "GET") {
      const hubId = query.hub_id

      if (!hubId) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: "Hub ID obrigatório" }))
        return
      }

      const tokenValidation = await validateAndRefreshToken(hubId)

      if (!tokenValidation.valid) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: tokenValidation.error }))
        return
      }

      const usersResult = await getHubSpotUsers(tokenValidation.token)

      if (usersResult.success) {
        // Buscar ramais já salvos
        const savedExtensions = await pool.query(
          "SELECT user_email, ramal FROM hubspot_usuarios_ramais WHERE hub_id = $1",
          [hubId],
        )

        const extensionsMap = {}
        savedExtensions.rows.forEach((row) => {
          extensionsMap[row.user_email] = row.ramal
        })

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            success: true,
            users: usersResult.users,
            extensions: extensionsMap,
          }),
        )
      } else {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: usersResult.error }))
      }
    }

    // Rota para salvar ramais
    else if (path === "/api/save-extensions" && req.method === "POST") {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", async () => {
        try {
          const { hubId, extensions } = JSON.parse(body)

          if (!hubId) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ success: false, error: "Hub ID obrigatório" }))
            return
          }

          // Verificar se hub_id existe
          const hubExists = await pool.query("SELECT hub_id FROM conector_hubspot WHERE hub_id = $1", [hubId])

          if (hubExists.rows.length === 0) {
            res.writeHead(404, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ success: false, error: "Hub ID não encontrado" }))
            return
          }

          // Remover ramais existentes para este hub_id
          await pool.query("DELETE FROM hubspot_usuarios_ramais WHERE hub_id = $1", [hubId])

          // Inserir novos ramais
          for (const [userEmail, ramal] of Object.entries(extensions)) {
            if (ramal && ramal.trim()) {
              await pool.query(
                "INSERT INTO hubspot_usuarios_ramais (hub_id, user_email, ramal, created_at) VALUES ($1, $2, $3, NOW())",
                [hubId, userEmail, ramal.trim()],
              )
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: true }))
        } catch (error) {
          console.error("Erro ao salvar ramais:", error)
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: false, error: "Erro interno" }))
        }
      })
    }

    // Rota para verificar se hub_id é válido (para evitar tela de login)
    else if (path === "/api/validate-hub" && req.method === "GET") {
      const hubId = query.hub_id

      if (!hubId) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ valid: false }))
        return
      }

      const result = await pool.query("SELECT hub_id FROM conector_hubspot WHERE hub_id = $1", [hubId])

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ valid: result.rows.length > 0 }))
    }

    // Rota para buscar dados do hub
    else if (path === "/api/get-hub-data" && req.method === "GET") {
      const hubId = query.hub_id

      if (!hubId) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: "Hub ID obrigatório" }))
        return
      }

      const result = await pool.query("SELECT token_sonax, client_id_sonax FROM conector_hubspot WHERE hub_id = $1", [
        hubId,
      ])

      if (result.rows.length === 0) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: "Hub não encontrado" }))
        return
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          success: true,
          data: result.rows[0],
        }),
      )
    }

    // Rota não encontrada
    else {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Rota não encontrada" }))
    }
  } catch (error) {
    console.error("Erro no servidor:", error)
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Erro interno do servidor" }))
  }
})

const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
})

// Teste de conexão com o banco
pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error("Erro ao conectar com o banco:", err)
  } else {
    console.log("Conectado ao banco de dados PostgreSQL")
  }
})