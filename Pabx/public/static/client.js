// Exemplo de como usar as APIs do backend no frontend

// 1. Salvar credenciais iniciais (após OAuth do HubSpot)
async function saveCredentials(token, clientId, accessToken, refreshToken, expiresIn) {
  const response = await fetch("http://localhost:3000/api/save-credentials", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token,
      clientId,
      accessToken,
      refreshToken,
      expiresIn,
    }),
  })

  const result = await response.json()
  if (result.success) {
    // Redirecionar para página de ramais com hub_id
    window.location.href = `/ramais?hub_id=${result.hubId}`
  }
}

// 2. Validar hub_id (para evitar tela de login)
async function validateHub(hubId) {
  const response = await fetch(`http://localhost:3000/api/validate-hub?hub_id=${hubId}`)
  const result = await response.json()
  return result.valid
}

// 3. Buscar usuários do HubSpot
async function getUsers(hubId) {
  const response = await fetch(`http://localhost:3000/api/get-users?hub_id=${hubId}`)
  const result = await response.json()

  if (result.success) {
    return {
      users: result.users,
      extensions: result.extensions,
    }
  } else {
    throw new Error(result.error)
  }
}

// 4. Salvar ramais
async function saveExtensions(hubId, extensions) {
  const response = await fetch("http://localhost:3000/api/save-extensions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      hubId,
      extensions,
    }),
  })

  const result = await response.json()
  return result.success
}

// 5. Buscar dados do hub
async function getHubData(hubId) {
  const response = await fetch(`http://localhost:3000/api/get-hub-data?hub_id=${hubId}`)
  const result = await response.json()

  if (result.success) {
    return result.data
  } else {
    throw new Error(result.error)
  }
}

// Função para renderizar a interface de usuários
function renderUsersInterface(users, extensions) {
  // Implementação da função para renderizar a interface
  console.log("Rendering users interface with:", users, extensions)
}

// Função para mostrar a tela de login
function showLoginScreen() {
  // Implementação da função para mostrar a tela de login
  console.log("Showing login screen")
}

// Exemplo de fluxo completo
async function initializeApp() {
  const urlParams = new URLSearchParams(window.location.search)
  const hubId = urlParams.get("hub_id")

  if (hubId) {
    // Verificar se hub_id é válido
    const isValid = await validateHub(hubId)

    if (isValid) {
      // Carregar usuários e ramais existentes
      try {
        const { users, extensions } = await getUsers(hubId)
        // Renderizar interface com dados
        renderUsersInterface(users, extensions)
      } catch (error) {
        console.error("Erro ao carregar usuários:", error)
        // Mostrar tela de erro ou login
        showLoginScreen()
      }
    } else {
      // Hub ID inválido, mostrar tela de login
      showLoginScreen()
    }
  } else {
    // Sem hub_id, mostrar tela de login
    showLoginScreen()
  }
}
