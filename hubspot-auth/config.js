const fs = require("fs")
const path = require("path")

function loadConfig() {
  try {
    const configPath = path.join(__dirname, "config.json")
    const configFile = fs.readFileSync(configPath, "utf8")
    const config = JSON.parse(configFile)

    console.log("✅ Configuração carregada do config.json")
    return config
  } catch (error) {
    console.error("❌ Erro ao carregar config.json:", error)
    process.exit(1)
  }
}

module.exports = { loadConfig }
