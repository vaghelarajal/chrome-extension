chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.windowId) {
    return
  }

  await chrome.sidePanel.open({ windowId: tab.windowId })
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "MAP_PROFILE_WITH_AI") {
    return false
  }

  mapProfileWithAi(msg.payload)
    .then((data) => {
      sendResponse({ success: true, data })
    })
    .catch((error) => {
      sendResponse({
        success: false,
        error: error.message
      })
    })

  return true
})

async function mapProfileWithAi(rawProfile) {
  const response = await fetch("http://localhost:3000/map-profile", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(rawProfile)
  })

  const result = await response.json()

  if (!response.ok || !result.success) {
    throw new Error(result.error || "AI mapping failed")
  }

  return result.data
}
