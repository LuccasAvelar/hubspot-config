const express = require("express")
const axios = require("axios")
const dayjs = require("dayjs")
const utc = require("dayjs/plugin/utc")
const timezone = require("dayjs/plugin/timezone")
const { loadConfig } = require("./config")
const { saveOrUpdateToken, getTokenByHubId, isTokenExpired, refreshAccessToken } = require("./database")

dayjs.extend(utc)
dayjs.extend(timezone)

const config = loadConfig()
const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`)
  next()
})

app.get("/", (req, res) => {
  res.send(`
    <h1>HubSpot OAuth Integration</h1>
    <p>Servidor rodando na porta ${config.server.port}</p>
    <p>Use /oauth/callback para o redirect do HubSpot</p>
  `)
})

async function getAccountInfo(accessToken) {
  try {
    const response = await axios.get("https://api.hubapi.com/account-info/v3/details", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    })
    return response.data
  } catch (error) {
    try {
      const altResponse = await axios.get("https://api.hubapi.com/integrations/v1/me", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      })
      return altResponse.data
    } catch (altError) {
      throw altError
    }
  }
}

app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query

  if (!code) {
    return res.status(400).send("❌ Código de autorização não encontrado")
  }

  try {
    const tokenRequest = {
      grant_type: "authorization_code",
      client_id: config.hubspot.clientId,
      client_secret: config.hubspot.clientSecret,
      redirect_uri: config.hubspot.redirectUri,
      code: code,
    }

    const response = await axios.post("https://api.hubapi.com/oauth/v1/token", null, {
      params: tokenRequest,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    })

    const { refresh_token, access_token, expires_in, hub_id } = response.data

    let finalPortalId = null

    if (hub_id) {
      finalPortalId = Number.parseInt(hub_id)
    } else {
      try {
        const accountInfo = await getAccountInfo(access_token)
        const possibleIds = [
          accountInfo.portalId,
          accountInfo.hubId,
          accountInfo.portal_id,
          accountInfo.hub_id,
          accountInfo.accountId,
          accountInfo.id,
        ]
        for (const id of possibleIds) {
          if (id && !isNaN(Number.parseInt(id))) {
            finalPortalId = Number.parseInt(id)
            break
          }
        }
      } catch (apiError) {
        console.error("Erro ao buscar dados da conta:", apiError.message)
      }
    }

    if (!finalPortalId) {
      finalPortalId = Date.now()
    }

    // ⏰ Pegando hora de Brasília
    const now = dayjs().tz("America/Sao_Paulo")
    const expiresAt = now.add(expires_in, "second")

    const savedToken = await saveOrUpdateToken({
      hubId: finalPortalId.toString(),
      refreshToken: refresh_token,
      accessToken: access_token,
      expiresAt: expiresAt.toDate(),
      createdAt: now.toDate(),
      updatedAt: now.toDate(),
    })

    const hubspotRedirectUrl = `https://app.hubspot.com/integrations-settings/${finalPortalId}/installed`

    res.send(`
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center;">
        <h1 style="color: #00A4BD;">✅ Integração Concluída!</h1>
        <p>Portal ID: <strong>${finalPortalId}</strong></p>
        <p>Token expira em: <strong>${expiresAt.format("DD/MM/YYYY HH:mm:ss")}</strong></p>
        <div style="margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 8px; text-align: left;">
          <h3>🔍 Debug Info:</h3>
          <p><strong>Hub ID da OAuth:</strong> ${hub_id || "undefined"}</p>
          <p><strong>Portal ID final:</strong> ${finalPortalId}</p>
          <p><strong>Método usado:</strong> ${hub_id ? "OAuth Response" : "Account API"}</p>
        </div>
        <p style="margin: 30px 0;">
          <a href="${hubspotRedirectUrl}" style="background: #00A4BD; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
            Voltar para o HubSpot
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">Você será redirecionado automaticamente em 5 segundos...</p>
        <script>
          setTimeout(() => {
            window.location.href = '${hubspotRedirectUrl}';
          }, 5000);
        </script>
      </div>
    `)
  } catch (err) {
    console.error("Erro no callback:", err)
    res.status(500).send(`
      <h1 style="color:red;">Erro ao autenticar</h1>
      <pre>${err.message}</pre>
    `)
  }
})

app.get("/token/status/:hubId", async (req, res) => {
  try {
    const { hubId } = req.params
    const tokenData = await getTokenByHubId(hubId)

    if (!tokenData) {
      return res.status(404).json({ error: "Token não encontrado" })
    }

    const expired = await isTokenExpired(hubId)

    res.json({
      hubId,
      hasToken: true,
      expired,
      expiresAt: tokenData.expires_at,
      createdAt: tokenData.created_at,
      updatedAt: tokenData.updated_at,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/token/:hubId", async (req, res) => {
  try {
    const { hubId } = req.params
    const expired = await isTokenExpired(hubId)

    if (expired) {
      const newAccessToken = await refreshAccessToken(hubId)
      return res.json({
        accessToken: newAccessToken,
        renewed: true,
      })
    }

    const tokenData = await getTokenByHubId(hubId)
    res.json({
      accessToken: tokenData.access_token,
      renewed: false,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err)
  res.status(500).json({ error: "Erro interno do servidor" })
})

app.listen(config.server.port, () => {
  console.log(`🚀 Servidor rodando na porta ${config.server.port}`)
})
