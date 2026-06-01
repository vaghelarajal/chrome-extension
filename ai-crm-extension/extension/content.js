if (!window.profileScraperContentLoaded) {
  window.profileScraperContentLoaded = true

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Handle scroll commands from background script
    if (msg.type === "SCROLL_TO" || msg.type === "SCROLL_TO_ABSOLUTE") {
      const targetScroll = msg.scrollY
      
      // Find scrollable element
      const scrollableElement = findScrollableElement()
      
      if (scrollableElement) {
        scrollableElement.scrollTop = targetScroll
      } else {
        window.scrollTo({ top: targetScroll, behavior: 'instant' })
        document.documentElement.scrollTop = targetScroll
        document.body.scrollTop = targetScroll
      }
      
      setTimeout(() => {
        const actualScroll = scrollableElement 
          ? scrollableElement.scrollTop 
          : (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop)
        sendResponse({ success: true, scrollY: actualScroll })
      }, 200)
      return true
    }
    
    if (msg.type === "SCROLL_BY") {
      const scrollAmount = msg.scrollY === 'viewport' ? window.innerHeight : msg.scrollY
      
      // Get current position
      let currentScroll = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
      const targetScroll = currentScroll + scrollAmount
      
      // Find the actual scrollable element
      const scrollableElement = findScrollableElement()
      
      if (scrollableElement) {
        // Scroll the container
        scrollableElement.scrollTop = targetScroll
        scrollableElement.scrollBy({ top: scrollAmount, behavior: 'smooth' })
      } else {
        // Try window scroll
        window.scrollTo({ top: targetScroll, behavior: 'smooth' })
        document.documentElement.scrollTop = targetScroll
        document.body.scrollTop = targetScroll
      }
      
      setTimeout(() => {
        const actualScroll = scrollableElement 
          ? scrollableElement.scrollTop 
          : (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop)
        sendResponse({ success: true, scrollY: actualScroll })
      }, 200)
      return true
    }
    
    function findScrollableElement() {
      // Check common LinkedIn scrollable containers
      const selectors = [
        'main',
        '[role="main"]',
        '.scaffold-layout__main',
        '.core-rail',
        'body > div',
        '#main'
      ]
      
      for (const selector of selectors) {
        const element = document.querySelector(selector)
        if (element && element.scrollHeight > element.clientHeight) {
          return element
        }
      }
      
      // Find any scrollable element
      const allElements = document.querySelectorAll('*')
      for (const element of allElements) {
        if (element.scrollHeight > element.clientHeight + 10 && 
            element.clientHeight > 400) {
          return element
        }
      }
      
      return null
    }
    
    if (msg.type !== "EXTRACT_PAGE") {
      return false
    }

    preparePageForScraping()
      .then(async () => {
        const rawProfile = await buildRawProfile()
        const confidence = rawProfile.confidence?.score || 0

        console.log(`📊 Confidence: ${confidence}%`)

        // PRODUCTION: Use text extraction for high confidence profiles
        if (confidence >= 60) {  // Production threshold
          // HIGH confidence - use text-based extraction
          chrome.runtime.sendMessage(
            { type: "MAP_PROFILE_TEXT", payload: rawProfile },
            (response) => {
              if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message })
                return
              }
              console.log(JSON.stringify(response.data, null, 2))
              sendResponse(response)
            }
          )
        } else {
          // LOW confidence - use vision fallback
          chrome.runtime.sendMessage(
            { type: "MAP_PROFILE_VISION", payload: rawProfile },
            (response) => {
              if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message })
                return
              }
              console.log(JSON.stringify(response.data, null, 2))
              sendResponse(response)
            }
          )
        }
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message })
      })

    return true
  })
}

// ─────────────────────────────────────────────
// PHASE ORCHESTRATOR
// ─────────────────────────────────────────────

async function preparePageForScraping() {
  // Scroll to trigger lazy-loading
  await scrollForLazyContent()
  // Return to top for extraction
  window.scrollTo({ top: 0, behavior: "instant" })
  await wait(250)
}

// ─────────────────────────────────────────────
// SCROLL — triggers LinkedIn lazy loading
// ─────────────────────────────────────────────

async function scrollForLazyContent() {
  const maxScrolls  = 12
  const viewportStep = Math.max(450, Math.floor(window.innerHeight * 0.65))
  let previousHeight = 0

  window.scrollTo({ top: 0, behavior: "instant" })
  await wait(200)

  for (let i = 0; i < maxScrolls; i++) {
    window.scrollBy({ top: viewportStep, behavior: "smooth" })
    await wait(550)

    const currentHeight = document.documentElement.scrollHeight
    const atBottom = window.scrollY + window.innerHeight >= currentHeight - 20

    if (currentHeight === previousHeight && atBottom) break
    previousHeight = currentHeight
  }

  await wait(500)
}

// ─────────────────────────────────────────────
// BUILD RAW PROFILE
// ─────────────────────────────────────────────

async function buildRawProfile() {
  const sourceUrl      = window.location.href
  const sourceHost     = window.location.hostname.replace(/^www\./, "")
  const structuredData = getStructuredData()
  const distilledText = distillPageText()
  const visibleText = document.body.innerText || ""
  const cleanVisibleText = cleanText(visibleText)
  const imageCandidates = findImageCandidates()
  const localExtraction = extractLocalProfile({
    sourceUrl,
    sourceHost,
    structuredData,
    visibleText: cleanVisibleText,
    imageCandidates
  })
  const confidence = calculateConfidence(localExtraction)

  const skillsSections = findLabeledSections(["skills", "skill"])
  const experienceSections = findLabeledSections(["experience", "experiences"])
  const educationSections = findLabeledSections(["education"])
  const certificationSections = findLabeledSections(["certifications", "certification", "licenses"])
  const projectsSections = findLabeledSections(["projects", "project"])
  const languagesSections = findLabeledSections(["languages", "language"])

  const primaryText = visibleText.length > distilledText.length ? visibleText : distilledText

  return {
    source_platform:  sourceHost,
    source_url:       sourceUrl,
    source_host:      sourceHost,
    extracted_at:     new Date().toISOString(),
    page_title:       document.title,
    meta:             getMetaData(),
    structured_data: structuredData,
    candidate_name:   findBestNameCandidate(),
    candidate_description: findBestDescriptionCandidate(),
    candidate_image:  imageCandidates[0]?.src || "",
    image_candidates: imageCandidates,
    emails:           findEmails(cleanVisibleText),
    phones:           findPhones(cleanVisibleText),
    links:            findLinks(),
    headings:         findHeadings(),
    sections:         findSections(),
    skills_sections: skillsSections.length > 0 ? skillsSections : [],
    experience_sections: experienceSections.length > 0 ? experienceSections : [],
    education_sections: educationSections.length > 0 ? educationSections : [],
    certification_sections: certificationSections.length > 0 ? certificationSections : [],
    projects_sections: projectsSections.length > 0 ? projectsSections : [],
    languages_sections: languagesSections.length > 0 ? languagesSections : [],
    contact_links: findContactLinks(),
    social_links: findSocialLinks(),
    distilled_text: "",
    local_extraction: localExtraction,
    confidence,
    visible_text:     primaryText
  }
}

// ─────────────────────────────────────────────
// META
// ─────────────────────────────────────────────

function getMetaData() {
  return {
    title:       getMetaContent("og:title")       || getMetaContent("twitter:title")       || "",
    description: getMetaContent("description")    || getMetaContent("og:description")      || getMetaContent("twitter:description") || "",
    image:       getMetaContent("og:image")       || getMetaContent("twitter:image")       || ""
  }
}

function getMetaContent(name) {
  return document
    .querySelector(`meta[name="${name}"], meta[property="${name}"]`)
    ?.content?.trim() || ""
}

function getStructuredData() {
  return {
    json_ld: getJsonLdData(),
    open_graph: getOpenGraphData(),
    meta: getAllMetaData()
  }
}

function getJsonLdData() {
  return [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(script => {
      try {
        return JSON.parse(script.textContent || "")
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function getOpenGraphData() {
  const data = {}

  document.querySelectorAll('meta[property^="og:"], meta[property^="profile:"]').forEach(meta => {
    const key = meta.getAttribute("property")
    const value = meta.getAttribute("content")

    if (key && value) {
      data[key] = value.trim()
    }
  })

  return data
}

function getAllMetaData() {
  const data = {}

  document.querySelectorAll("meta[name], meta[property]").forEach(meta => {
    const key = meta.getAttribute("name") || meta.getAttribute("property")
    const value = meta.getAttribute("content")

    if (key && value) {
      data[key] = value.trim()
    }
  })

  return data
}

function distillPageText() {
  const root = document.querySelector("main, article, [role='main']") || document.body
  const clone = root.cloneNode(true)

  clone.querySelectorAll([
    "script",
    "style",
    "svg",
    "canvas",
    "noscript",
    "nav",
    "footer",
    "aside",
    "button",
    "[role='button']",
    "[role='navigation']",
    "[aria-hidden='true']",
    "[hidden]"
  ].join(",")).forEach(element => element.remove())

  const blocks = [...clone.querySelectorAll("h1,h2,h3,h4,p,li,dt,dd,span")]
    .map(element => cleanText(element.innerText || element.textContent || ""))
    .filter(text => text.length >= 2)
    .filter(text => !isLikelyBoilerplateText(text))

  return unique(blocks).join("\n")
}

function isLikelyBoilerplateText(text) {
  return /^(home|menu|search|notifications|messaging|jobs|premium|advertising|privacy|terms|help|settings)$/i.test(text)
}

// ─────────────────────────────────────────────
// NAME + DESCRIPTION
// ─────────────────────────────────────────────

function findBestNameCandidate() {
  const candidates = [
    ...textFromSelectors("h1"),
    getMetaContent("og:title"),
    getMetaContent("twitter:title"),
    document.title
  ]
  return cleanText(candidates.find(Boolean) || "")
}

function findBestDescriptionCandidate() {
  const candidates = [
    getMetaContent("description"),
    getMetaContent("og:description"),
    getMetaContent("twitter:description"),
    ...textFromSelectors("main p, article p, section p")
  ]
  return cleanText(candidates.find(Boolean) || "").slice(0, 1000)
}

// ─────────────────────────────────────────────
// IMAGES
// ─────────────────────────────────────────────

function findImageCandidates() {
  const metaImage = getMetaContent("og:image") || getMetaContent("twitter:image")
  const pageName  = cleanText(findBestNameCandidate())

  const candidates = [...document.querySelectorAll("img[src]")]
    .map((img) => {
      const rect   = img.getBoundingClientRect()
      const width  = img.naturalWidth  || img.width  || Math.round(rect.width)  || 0
      const height = img.naturalHeight || img.height || Math.round(rect.height) || 0
      const nearbyText = cleanText(
        img.closest("section, article, header, main, div")?.innerText || ""
      ).slice(0, 300)

      return {
        src: img.src,
        alt: cleanText(img.alt),
        width,
        height,
        nearby_text: nearbyText,
        score: scoreImage(img, width, height, nearbyText, pageName)
      }
    })
    .filter(img => img.src.startsWith("http"))
    .filter(img => img.width >= 64 && img.height >= 64)
    .filter(img => !isLikelyLogoOrIcon(img))

  if (metaImage) {
    candidates.push({ src: metaImage, alt: "meta image", width: 0, height: 0, nearby_text: "", score: 1 })
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score, ...img }) => img)
}

function scoreImage(img, width, height, nearbyText, pageName) {
  const combined = `${img.alt} ${img.src} ${img.className} ${img.id} ${nearbyText}`.toLowerCase()
  const ratio    = width && height ? width / height : 1
  let score = 0

  if (combined.match(/profile|avatar|photo|headshot|portrait|person|user/)) score += 6
  if (pageName && combined.includes(pageName.toLowerCase()))                 score += 8
  if (ratio >= 0.65 && ratio <= 1.45)                                        score += 3
  if (width >= 96 && height >= 96)                                           score += 2
  if (width >= 500 || height >= 300)                                         score -= 2
  if (combined.match(/banner|cover|background|logo|icon|sprite|emoji|badge|ad/)) score -= 5
  if (img.closest?.("nav, header, aside, footer, [role='navigation']"))      score -= 8

  return score
}

function isLikelyLogoOrIcon(img) {
  return /logo|icon|sprite|favicon|badge/.test(`${img.alt} ${img.src}`.toLowerCase())
}

// ─────────────────────────────────────────────
// EMAILS + PHONES
// ─────────────────────────────────────────────

function findEmails(text) {
  const mailtoEmails = [...document.querySelectorAll('a[href^="mailto:"]')]
    .map(l => l.href.replace("mailto:", "").split("?")[0].trim())
    .filter(e => /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(e))

  const textEmails = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .filter(e => !["example.com","test.com","demo.com","placeholder.com"]
      .includes(e.split("@")[1]?.toLowerCase()))

  return unique([...mailtoEmails, ...textEmails]).slice(0, 10)
}

function findPhones(text) {
  const telPhones = [...document.querySelectorAll('a[href^="tel:"]')]
    .map(l => normalizePhone(l.href.replace("tel:", "")))
    .filter(Boolean)

  const labeledPhones = []
  const pattern = /(?:phone|mobile|tel|telephone|contact|call|whatsapp)\s*:?\s*(\+?\d[\d\s().-]{7,}\d)/gi
  let match
  while ((match = pattern.exec(text)) !== null) {
    const p = normalizePhone(match[1])
    if (p) labeledPhones.push(p)
  }

  return unique([...telPhones, ...labeledPhones]).slice(0, 5)
}

function normalizePhone(value) {
  const clean  = String(value || "").trim()
  const digits = clean.replace(/\D/g, "")
  if (digits.length < 10 || digits.length > 15) return ""
  if (/(\d)\1{7,}/.test(digits)) return ""
  return clean
}

// ─────────────────────────────────────────────
// LINKS + HEADINGS + SECTIONS
// ─────────────────────────────────────────────

function findLinks() {
  return [...document.querySelectorAll("a[href]")]
    .map(l => ({ text: cleanText(l.innerText).slice(0, 80), href: l.href }))
    .filter(l => l.href.startsWith("http"))
}

function findHeadings() {
  return textFromSelectors("h1,h2,h3").map(cleanText).filter(Boolean)
}

function findSections() {
  const sections = []
  const mainContent = document.querySelector("main, article, [role='main']")
  const targets = mainContent
    ? [mainContent]
    : [...document.querySelectorAll("main, article, section")]

  targets.forEach(container => {
    const text = cleanText(container.innerText)
    if (text.length >= 40 && text.length <= 5000) sections.push(text)
  })

  return sections
}

function findLabeledSections(labels) {
  const normalizedLabels = labels.map(label => label.toLowerCase())
  const sections = []
  const seenTexts = new Set()

  // Get the main content area
  const mainContent = document.querySelector('main') || document.body
  
  // Get ALL text from the page
  const fullPageText = mainContent.innerText || mainContent.textContent || ""
  
  // Split by double newlines to get blocks
  const blocks = fullPageText.split(/\n\n+/)
  
  // Find blocks that contain our target labels
  let captureMode = false
  let currentSection = []
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim()
    if (!block) continue
    
    const blockLower = block.toLowerCase()
    
    // Check if this block is a section header we're looking for
    const isTargetHeader = normalizedLabels.some(label => {
      const lines = block.split('\n')
      const firstLine = lines[0].toLowerCase().trim()
      return firstLine === label || 
             firstLine === label + 's' ||
             firstLine.includes(label) ||
             blockLower.startsWith(label)
    })
    
    if (isTargetHeader) {
      // Save previous section if any
      if (currentSection.length > 0) {
        const sectionText = currentSection.join('\n\n')
        if (sectionText.length >= 50 && !seenTexts.has(sectionText)) {
          seenTexts.add(sectionText)
          sections.push(sectionText)
        }
      }
      
      // Start new section
      captureMode = true
      currentSection = [block]
      continue
    }
    
    // Check if we hit another major section (stop capturing)
    const isOtherMajorSection = /^(about|activity|analytics|resources|featured|posts|articles|recommendations|interests|groups|events|courses|honors|awards|publications|patents|test scores|organizations|volunteering)/i.test(block.split('\n')[0])
    
    if (captureMode && isOtherMajorSection) {
      // Save current section and stop
      if (currentSection.length > 0) {
        const sectionText = currentSection.join('\n\n')
        if (sectionText.length >= 50 && !seenTexts.has(sectionText)) {
          seenTexts.add(sectionText)
          sections.push(sectionText)
        }
      }
      captureMode = false
      currentSection = []
      continue
    }
    
    // If in capture mode, add this block
    if (captureMode) {
      currentSection.push(block)
    }
  }
  
  // Don't forget the last section
  if (currentSection.length > 0) {
    const sectionText = currentSection.join('\n\n')
    if (sectionText.length >= 50 && !seenTexts.has(sectionText)) {
      seenTexts.add(sectionText)
      sections.push(sectionText)
    }
  }
  
  return sections
}

function findSectionHeadingCandidates() {
  const semanticHeadings = [...document.querySelectorAll("h1,h2,h3,h4,h5,[role='heading']")]
  const textHeadings = [...document.querySelectorAll("section *, main *, article *, div[id*='experience'], div[id*='education'], div[id*='skills']")]
    .filter(el => {
      if (!isVisible(el)) {
        return false
      }

      const text = cleanText(el.innerText || el.getAttribute("aria-label") || el.textContent || "")
      return /^(experience|education|skills?|licenses & certifications|certifications|projects|languages?)$/i.test(text)
    })

  return uniqueElements([...semanticHeadings, ...textHeadings])
}

function findUsefulSectionContainer(heading, headingText) {
  const nearestSection = heading.closest("section")

  if (nearestSection) {
    return nearestSection
  }

  let current = heading.parentElement

  while (current && current !== document.body) {
    const text = cleanMultilineText(current.innerText || "")

    if (text.length > headingText.length + 40 && text.length < 50000) {
      return current
    }

    current = current.parentElement
  }

  return heading.closest("section, article, main, div") || heading.parentElement
}

function normalizeSectionLabel(text) {
  return cleanText(text).toLowerCase()
}

function extractVisibleTextFromSection(container) {
  if (!container) {
    return ""
  }

  // Clone the container to avoid modifying the actual DOM
  const clone = container.cloneNode(true)

  // Remove elements that shouldn't be included in text extraction
  clone.querySelectorAll([
    "script",
    "style",
    "svg",
    "canvas",
    "noscript"
  ].join(",")).forEach(element => element.remove())

  // Get all text content including from elements that might be visually hidden but in DOM
  const allText = clone.innerText || clone.textContent || ""
  
  return cleanMultilineText(allText)
}

function normalizeSectionLabel(text) {
  return cleanText(text).toLowerCase()
}

function findContactLinks() {
  return findLinks().filter(link => {
    const text = `${link.text} ${link.href}`.toLowerCase()
    return /mailto:|tel:|email|phone|contact|website/.test(text)
  })
}

function findSocialLinks() {
  return findLinks().filter(link => {
    const href = link.href.toLowerCase()
    return /linkedin\.com|github\.com|twitter\.com|x\.com|facebook\.com|instagram\.com/.test(href)
  })
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function extractLocalProfile({ sourceUrl, sourceHost, structuredData, visibleText, imageCandidates }) {
  const candidateName = findStructuredName(structuredData) || findBestNameCandidate()
  const fullName = cleanProfileName(candidateName)
  const nameParts = splitName(fullName)
  const links = findLinks()
  const socialLinks = findSocialLinks()
  const skillsSections = findLabeledSections(["skills", "skill"])
  const experienceSections = findLabeledSections(["experience", "experiences"])
  const educationSections = findLabeledSections(["education"])
  const certificationSections = findLabeledSections(["certifications", "certification", "licenses"])
  const projectSections = findLabeledSections(["projects", "project"])

  return {
    source_url: sourceUrl,
    source_host: sourceHost,
    full_name: fullName,
    first_name: nameParts.firstName,
    last_name: nameParts.lastName,
    headline: findHeadline(structuredData),
    location: findLocationCandidate(visibleText),
    email: findEmails(visibleText)[0] || "",
    phone: findPhones(visibleText)[0] || "",
    website: findWebsiteLink(links, sourceHost),
    linkedin: findLinkByHost(socialLinks, "linkedin.com"),
    github: findLinkByHost(socialLinks, "github.com"),
    twitter: findLinkByHost(socialLinks, "twitter.com") || findLinkByHost(socialLinks, "x.com"),
    profile_photo_url: imageCandidates[0]?.src || getMetaData().image || "",
    skills: extractSkillsFromSections(skillsSections),
    experience_sections: experienceSections,
    education_sections: educationSections,
    certification_sections: certificationSections,
    projects_sections: projectSections,
    social_links: socialLinks
  }
}

function calculateConfidence(localExtraction) {
  let score = 0
  const reasons = []

  addConfidence(Boolean(localExtraction.full_name), 20, "name")
  addConfidence(Boolean(localExtraction.headline), 15, "headline")
  addConfidence(Boolean(localExtraction.location), 10, "location")
  addConfidence(Boolean(localExtraction.email || localExtraction.linkedin || localExtraction.github), 10, "contact_or_social")
  addConfidence(localExtraction.skills.length > 0, 15, "skills")
  addConfidence(localExtraction.experience_sections.length > 0, 20, "experience")
  addConfidence(localExtraction.education_sections.length > 0, 15, "education")
  addConfidence(Boolean(localExtraction.profile_photo_url), 5, "profile_photo")

  return {
    score,
    level: score >= 70 ? "high" : score >= 40 ? "medium" : "low",
    reasons
  }

  function addConfidence(condition, points, reason) {
    if (!condition) {
      return
    }

    score += points
    reasons.push(reason)
  }
}

function findStructuredName(structuredData) {
  const values = flattenStructuredValues(structuredData.json_ld)
  const profileFirstName = structuredData.open_graph["profile:first_name"]
  const profileLastName = structuredData.open_graph["profile:last_name"]

  return values.find(value => value.key === "name")?.value ||
    (profileFirstName ? `${profileFirstName} ${profileLastName || ""}`.trim() : "") ||
    structuredData.open_graph["og:title"] ||
    ""
}

function findHeadline(structuredData) {
  return structuredData.meta.description ||
    structuredData.open_graph["og:description"] ||
    structuredData.meta["twitter:description"] ||
    ""
}

function findLocationCandidate(text) {
  const locationMatch = text.match(/\b[A-Z][a-zA-Z .'-]+,\s*[A-Z][a-zA-Z .'-]+(?:,\s*[A-Z][a-zA-Z .'-]+)?\b/)

  return locationMatch?.[0] || ""
}

function flattenStructuredValues(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach(item => flattenStructuredValues(item, result))
    return result
  }

  if (!value || typeof value !== "object") {
    return result
  }

  Object.entries(value).forEach(([key, nestedValue]) => {
    if (typeof nestedValue === "string") {
      result.push({ key, value: nestedValue })
      return
    }

    flattenStructuredValues(nestedValue, result)
  })

  return result
}

function extractSkillsFromSections(sections) {
  const labelPattern = /^(skills?|top skills?|show all|see all|\d+\s+endorsements?)$/i

  return unique(sections
    .flatMap(section => section.split(/[,|\n]/))
    .map(cleanText)
    .filter(skill => skill.length >= 2 && skill.length <= 60)
    .filter(skill => !labelPattern.test(skill)))
    .slice(0, 50)
}

function cleanProfileName(name) {
  return cleanText(name)
    .replace(/\s+[|-]\s+.+$/i, "")
    .replace(/\s+profile$/i, "")
}

function splitName(fullName) {
  const parts = cleanText(fullName).split(" ").filter(Boolean)

  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" ")
  }
}

function findLinkByHost(links, host) {
  return links.find(link => link.href.toLowerCase().includes(host))?.href || ""
}

function findWebsiteLink(links, sourceHost) {
  return links.find(link => {
    try {
      const host = new URL(link.href).hostname.replace(/^www\./, "")
      return sourceHost && host !== sourceHost
    } catch {
      return false
    }
  })?.href || ""
}

function isVisible(el) {
  const rect  = el.getBoundingClientRect()
  const style = window.getComputedStyle(el)
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display    !== "none" &&
    Number(style.opacity) !== 0
  )
}

function textFromSelectors(selector) {
  return [...document.querySelectorAll(selector)]
    .map(el => el.innerText?.trim() || "")
    .filter(Boolean)
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim()
}

function cleanMultilineText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => cleanText(line))
    .filter(Boolean)
    .join("\n")
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function uniqueElements(values) {
  return [...new Set(values.filter(Boolean))]
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
