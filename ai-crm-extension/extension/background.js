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
  if (msg.type === 'MAP_PROFILE_TEXT') {
    // HIGH confidence - text-based extraction
    mapProfileWithText(msg.payload)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error.message }))
    return true
  }
  
  if (msg.type === 'MAP_PROFILE_VISION') {
    // LOW confidence - vision fallback
    mapProfileWithVision(msg.payload, sender.tab.id)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error.message }))
    return true
  }
  
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    // Screenshot capture helper
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 85 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message })
      } else {
        sendResponse({ dataUrl })
      }
    })
    return true
  }
})

// HIGH confidence flow - text only
async function mapProfileWithText(rawProfile) {
  const response = await fetch("http://localhost:3000/scrape/parse-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rawProfile)
  })

  const result = await response.json()

  if (!response.ok || !result.success) {
    throw new Error(result.error || "Text parsing failed")
  }

  return result.data
}

// LOW confidence flow - text first, then vision for missing fields
async function mapProfileWithVision(rawProfile, tabId) {
  // Step 1: Try text extraction first
  console.log('📝 Step 1: Attempting text extraction...')
  const textResponse = await fetch("http://localhost:3000/scrape/parse-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rawProfile)
  })

  const textResult = await textResponse.json()
  
  if (!textResponse.ok || !textResult.success) {
    throw new Error(textResult.error || "Text parsing failed")
  }

  console.log('📊 Text extraction result:', {
    experience: textResult.data.parsedExperience?.length || 0,
    education: textResult.data.parsedEducation?.length || 0,
    skills: textResult.data.parsedSkills?.length || 0
  })

  // Step 2: Check which fields are still missing
  const missingFields = checkMissingFields(textResult.data)
  
  // PRODUCTION: Only use vision if fields are actually missing
  const forceVisionTest = false
  
  if (missingFields.length === 0 && !forceVisionTest) {
    console.log('✅ All fields extracted from text - skipping vision')
    return textResult.data
  }

  console.log(`📸 Step 2: ${missingFields.length > 0 ? `Missing fields: ${missingFields.join(', ')}` : 'FORCING vision test (all fields present)'}`)
  console.log('📸 Capturing screenshots...')
  
  // Force at least one field to trigger screenshot capture
  const fieldsToCapture = missingFields.length > 0 ? missingFields : ['experience']

  // Step 3: Capture strategic screenshots
  const screenshots = await captureStrategicScreenshots(tabId, fieldsToCapture)

  // Step 4: Extract missing fields with vision
  console.log('🔍 Step 3: Extracting missing fields with vision...')
  const visionResponse = await fetch("http://localhost:3000/scrape/parse-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      screenshots,
      missingFields,
      textResult: textResult.data
    })
  })

  const visionResult = await visionResponse.json()

  if (!visionResponse.ok || !visionResult.success) {
    console.warn('⚠️ Vision extraction failed, returning text-only result')
    return textResult.data
  }

  console.log('✅ Vision extraction complete')
  return visionResult.data
}

function checkMissingFields(profile) {
  const missing = []
  
  if (!profile.parsedExperience || profile.parsedExperience.length === 0) {
    missing.push('experience')
  }
  
  if (!profile.parsedEducation || profile.parsedEducation.length === 0) {
    missing.push('education')
  }
  
  if (!profile.parsedSkills || profile.parsedSkills.length === 0) {
    missing.push('skills')
  }
  
  return missing
}

async function captureStrategicScreenshots(tabId, missingFields) {
  // Get the scrollable element info
  const [elementInfo] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const main = document.querySelector('main')
      return {
        scrollHeight: main ? main.scrollHeight : document.documentElement.scrollHeight,
        clientHeight: main ? main.clientHeight : window.innerHeight
      }
    }
  })
  
  const { scrollHeight, clientHeight } = elementInfo.result
  
  // Scroll to top
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SCROLL_TO', scrollY: 0 })
  } catch (error) {
    console.error(`❌ Scroll error:`, error.message)
  }
  await wait(1000)
  
  const screenshots = []
  
  // Define strategic scroll positions
  const capturePositions = [
    { label: 'header', scrollY: 0 },
    { label: 'about', scrollY: Math.floor(clientHeight * 0.8) },
    { label: 'experience', scrollY: Math.floor(scrollHeight * 0.35) },
    { label: 'education', scrollY: Math.floor(scrollHeight * 0.60) },
    { label: 'skills', scrollY: Math.floor(scrollHeight * 0.80) }
  ]
  
  for (let i = 0; i < capturePositions.length; i++) {
    const pos = capturePositions[i]
    
    // Scroll to position
    try {
      await chrome.tabs.sendMessage(tabId, { 
        type: 'SCROLL_TO_ABSOLUTE', 
        scrollY: pos.scrollY 
      })
    } catch (error) {
      console.error(`❌ Scroll failed:`, error.message)
    }
    await wait(1200)
    
    // Capture screenshot
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { 
      format: 'jpeg', 
      quality: 90 
    })
    
    screenshots.push({ 
      dataUrl, 
      label: pos.label,
      scrollY: pos.scrollY
    })
    
    // Download for debugging (optional - comment out in production)
    /*
    chrome.downloads.download({
      url: dataUrl,
      filename: `linkedin-${pos.label}.jpg`,
      saveAs: false
    })
    */
  }
  
  // Return to top
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SCROLL_TO', scrollY: 0 })
  } catch (error) {
    console.error(`❌ Failed to scroll back:`, error.message)
  }
  
  return screenshots
}

async function stitchScreenshots(screenshots, pageInfo) {
  console.log(`🎨 Stitching ${screenshots.length} screenshots...`)
  console.log(`📏 Canvas size: ${pageInfo.viewportWidth}x${pageInfo.fullHeight}`)
  
  try {
    // Try using OffscreenCanvas (modern approach)
    const canvas = new OffscreenCanvas(pageInfo.viewportWidth, pageInfo.fullHeight)
    const ctx = canvas.getContext('2d')
    
    console.log(`✅ OffscreenCanvas created successfully`)
    
    // Load and draw each screenshot
    for (let i = 0; i < screenshots.length; i++) {
      const screenshot = screenshots[i]
      
      // Convert data URL to image
      const response = await fetch(screenshot.dataUrl)
      const blob = await response.blob()
      const imageBitmap = await createImageBitmap(blob)
      
      // Draw at correct Y position
      const y = screenshot.scrollY
      ctx.drawImage(imageBitmap, 0, y)
      
      console.log(`  ✅ Drew segment ${i + 1} at Y=${y}, size=${imageBitmap.width}x${imageBitmap.height}`)
    }
    
    console.log(`🎨 Converting canvas to JPEG...`)
    
    // Convert canvas to compressed JPEG
    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: 0.85  // Increased quality for better text readability
    })
    
    console.log(`✅ JPEG blob created: ${Math.round(blob.size / 1024)}KB`)
    
    // Convert blob to data URL
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const dataUrl = reader.result
        console.log(`✅ Data URL created: ${Math.round(dataUrl.length / 1024)}KB`)
        resolve(dataUrl)
      }
      reader.readAsDataURL(blob)
    })
  } catch (error) {
    console.error('❌ OffscreenCanvas error:', error.message)
    console.warn('⚠️ Falling back to first screenshot only')
    
    // Fallback: Just return the first screenshot
    return screenshots[0].dataUrl
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
