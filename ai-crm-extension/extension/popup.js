const RECENT_KEY = "recentProfiles"
const MAX_RECENT_PROFILES = 10

const extractBtn = document.getElementById("extractBtn")
const clearBtn = document.getElementById("clearBtn")
const statusText = document.getElementById("statusText")
const profilesList = document.getElementById("profilesList")
const profileCount = document.getElementById("profileCount")
const pageTitle = document.getElementById("pageTitle")
const pageHost = document.getElementById("pageHost")

let currentTab = null

init()

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  currentTab = tab
  renderCurrentPage(tab)
  renderRecentProfiles()
}

extractBtn.addEventListener("click", async () => {
  if (!currentTab?.id) {
    showStatus("Open a normal webpage first.", true)
    return
  }

  extractBtn.disabled = true
  showStatus("Scanning current page...")

  try {
    const response = await sendExtractMessage(currentTab.id)

    if (!response?.success || !response.data) {
      showStatus("No profile data found on this page.", true)
      return
    }

    await saveRecentProfile(response.data)
    await renderRecentProfiles()
    showStatus("Profile captured. JSON printed in browser console.")
  } catch (error) {
    showStatus("Could not connect to this page. Refresh it and try again.", true)
  } finally {
    extractBtn.disabled = false
  }
})

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ [RECENT_KEY]: [] })
  await renderRecentProfiles()
  showStatus("Recent profiles cleared.")
})

function sendExtractMessage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "EXTRACT_PAGE" }, async (response) => {
      if (!chrome.runtime.lastError) {
        resolve(response)
        return
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"]
        })

        chrome.tabs.sendMessage(tabId, { type: "EXTRACT_PAGE" }, (retryResponse) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError)
            return
          }

          resolve(retryResponse)
        })
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function saveRecentProfile(data) {
  const existingProfiles = await getRecentProfiles()
  const nextProfile = {
    ...data,
    capturedAt: Date.now()
  }

  const profiles = [
    nextProfile,
    ...existingProfiles
  ].slice(0, MAX_RECENT_PROFILES)

  await chrome.storage.local.set({ [RECENT_KEY]: profiles })
}

async function renderRecentProfiles() {
  const profiles = await getRecentProfiles()
  profileCount.textContent = profiles.length
  profilesList.innerHTML = ""

  if (profiles.length === 0) {
    const empty = document.createElement("div")
    empty.className = "empty"
    empty.textContent = "No profiles yet. Open a profile page and click Scrape profile."
    profilesList.appendChild(empty)
    return
  }

  profiles.forEach((profile) => {
    profilesList.appendChild(createProfileCard(profile))
  })
}

async function getRecentProfiles() {
  const result = await chrome.storage.local.get(RECENT_KEY)
  return result[RECENT_KEY] || []
}

function createProfileCard(profile) {
  const personalInfo = profile.personal_info || {}
  const contactInfo = profile.contact_info || {}
  const fullName = personalInfo.full_name || [
    personalInfo.first_name,
    personalInfo.last_name
  ]
    .filter(Boolean)
    .join(" ") || "Unknown profile"

  const card = document.createElement("article")
  card.className = "profile-card"

  const avatar = document.createElement("div")
  avatar.className = "avatar"
  avatar.textContent = initialsFor(fullName)

  const main = document.createElement("div")
  main.className = "profile-main"

  const name = document.createElement("div")
  name.className = "profile-name"
  name.textContent = fullName

  const email = document.createElement("div")
  email.className = "profile-email"
  email.textContent = contactInfo.email || "No email found"

  const domain = document.createElement("div")
  domain.className = "profile-domain"
  domain.textContent = profile.source_platform || hostFromUrl(profile.source_url) || "Current page"

  const time = document.createElement("div")
  time.className = "profile-time"
  time.textContent = timeAgo(profile.capturedAt)

  main.appendChild(name)
  main.appendChild(email)
  main.appendChild(domain)
  card.appendChild(avatar)
  card.appendChild(main)
  card.appendChild(time)

  return card
}

function renderCurrentPage(tab) {
  if (!tab?.url) {
    pageTitle.textContent = "Current page"
    pageHost.textContent = "Unknown page"
    return
  }

  pageTitle.textContent = tab.title || "Current page"

  try {
    pageHost.textContent = new URL(tab.url).hostname
  } catch {
    pageHost.textContent = tab.url
  }
}

function showStatus(message, isError = false) {
  statusText.textContent = message
  statusText.classList.toggle("error", isError)
}

function initialsFor(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?"
}

function timeAgo(timestamp) {
  if (!timestamp) {
    return "now"
  }

  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))

  if (minutes < 1) {
    return "now"
  }

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}h ago`
  }

  return `${Math.floor(hours / 24)}d ago`
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}
