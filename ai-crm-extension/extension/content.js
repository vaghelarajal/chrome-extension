if (!window.profileScraperContentLoaded) {
  window.profileScraperContentLoaded = true

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "EXTRACT_PAGE") {
      return false
    }

    preparePageForScraping()
      .then(async () => {
        const rawProfile = await buildRawProfile()

        chrome.runtime.sendMessage(
          { type: "MAP_PROFILE_WITH_AI", payload: rawProfile },
          (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({
                success: false,
                error: chrome.runtime.lastError.message
              })
              return
            }

            if (!response?.success) {
              sendResponse(response)
              return
            }

            console.log(JSON.stringify(response.data, null, 2))
            sendResponse(response)
          }
        )
      })
      .catch((error) => {
        sendResponse({
          success: false,
          error: error.message
        })
      })

    return true
  })
}

async function preparePageForScraping() {
  await scrollForLazyContent()
  window.scrollTo({ top: 0, behavior: "instant" })
  await wait(250)
}

async function scrollForLazyContent() {
  const maxScrolls = 11
  const viewportStep = Math.max(450, Math.floor(window.innerHeight * 0.65))
  let previousHeight = 0

  window.scrollTo({ top: 0, behavior: "instant" })
  await wait(200)

  for (let index = 0; index < maxScrolls; index += 1) {
    window.scrollBy({ top: viewportStep, behavior: "smooth" })
    await wait(550)

    const currentHeight = document.documentElement.scrollHeight

    if (currentHeight === previousHeight && window.scrollY + window.innerHeight >= currentHeight - 20) {
      break
    }

    previousHeight = currentHeight
  }

  await wait(500)
}

function isVisible(element) {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)

  return rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    Number(style.opacity) !== 0
}

function getElementKey(element) {
  return [
    cleanText(element.innerText || element.getAttribute("aria-label") || ""),
    element.href || "",
    element.getAttribute("aria-controls") || "",
    element.getAttribute("data-control-name") || ""
  ].join("|")
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function buildRawProfile() {
  const sourceUrl = window.location.href
  const sourceHost = window.location.hostname.replace(/^www\./, "")
  const fullVisibleText = cleanText(document.body.innerText)
  const visibleText = fullVisibleText.length > 15000 ? fullVisibleText.slice(0, 15000) : fullVisibleText
  const imageCandidates = findImageCandidates()

  return {
    source_platform: sourceHost,
    source_url: sourceUrl,
    source_host: sourceHost,
    extracted_at: new Date().toISOString(),
    page_title: document.title,
    meta: getMetaData(),
    candidate_name: findBestNameCandidate(),
    candidate_description: findBestDescriptionCandidate(),
    candidate_image: imageCandidates[0]?.src || "",
    image_candidates: imageCandidates,
    emails: findEmails(visibleText),
    phones: findPhones(visibleText),
    links: findLinks(),
    headings: findHeadings(),
    sections: findSections(),
    expanded_pages: [],
    visible_text: visibleText
  }
}

function getMetaData() {
  return {
    title: getMetaContent("og:title") || getMetaContent("twitter:title") || "",
    description: getMetaContent("description") ||
      getMetaContent("og:description") ||
      getMetaContent("twitter:description") ||
      "",
    image: getMetaContent("og:image") || getMetaContent("twitter:image") || ""
  }
}

function getMetaContent(name) {
  return document
    .querySelector(`meta[name="${name}"], meta[property="${name}"]`)
    ?.content
    ?.trim() || ""
}

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

function findImageCandidates() {
  const metaImage = getMetaContent("og:image") || getMetaContent("twitter:image")
  const pageName = cleanText(findBestNameCandidate())
  const candidates = [...document.querySelectorAll("img[src]")]
    .map((image) => {
      const rect = image.getBoundingClientRect()
      const width = image.naturalWidth || image.width || Math.round(rect.width) || 0
      const height = image.naturalHeight || image.height || Math.round(rect.height) || 0
      const nearbyText = cleanText(
        image.closest("section, article, header, main, div")?.innerText || ""
      ).slice(0, 300)

      return {
        src: image.src,
        alt: cleanText(image.alt),
        width,
        height,
        nearby_text: nearbyText,
        score: scoreImageCandidate(image, width, height, nearbyText, pageName)
      }
    })
    .filter((image) => image.src.startsWith("http"))
    .filter((image) => image.width >= 64 && image.height >= 64)
    .filter((image) => !isLikelyLogoOrIcon(image))

  if (metaImage) {
    candidates.push({
      src: metaImage,
      alt: "meta image",
      width: 0,
      height: 0,
      nearby_text: "",
      score: 1
    })
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score, ...image }) => image)
}

function scoreImageCandidate(image, width, height, nearbyText, pageName) {
  const alt = image.alt || ""
  const src = image.src || ""
  const className = String(image.className || "")
  const id = image.id || ""
  const combinedText = `${alt} ${src} ${className} ${id} ${nearbyText}`.toLowerCase()
  const aspectRatio = width && height ? width / height : 1
  let score = 0

  if (combinedText.match(/profile|avatar|photo|headshot|portrait|person|user/)) {
    score += 6
  }

  const normalizedPageName = pageName.toLowerCase()

  if (normalizedPageName && combinedText.includes(normalizedPageName)) {
    score += 8
  }

  if (aspectRatio >= 0.65 && aspectRatio <= 1.45) {
    score += 3
  }

  if (width >= 96 && height >= 96) {
    score += 2
  }

  if (width >= 500 || height >= 300) {
    score -= 2
  }

  if (combinedText.match(/banner|cover|background|logo|icon|sprite|emoji|badge|ad/)) {
    score -= 5
  }

  if (isInsidePageChrome(image)) {
    score -= 8
  }

  if (normalizedPageName && !combinedText.includes(normalizedPageName) && nearbyText.length > 0) {
    score -= 2
  }

  return score
}

function isInsidePageChrome(element) {
  const container = element.closest("nav, header, aside, footer, [role='navigation'], [role='banner'], [aria-label*='navigation' i]")

  return Boolean(container)
}

function isLikelyLogoOrIcon(image) {
  const text = `${image.alt} ${image.src}`.toLowerCase()

  return Boolean(text.match(/logo|icon|sprite|favicon|badge/))
}

function findEmails(text) {
  const mailtoEmails = [...document.querySelectorAll('a[href^="mailto:"]')]
    .map((link) => link.href.replace("mailto:", "").split("?")[0].trim())
    .filter((email) => /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email))
    .filter(Boolean)

  const textEmails = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .filter((email) => {
      const domain = email.split("@")[1]?.toLowerCase()
      return !["example.com", "test.com", "demo.com", "placeholder.com"].includes(domain)
    })

  return unique([...mailtoEmails, ...textEmails]).slice(0, 10)
}

function findPhones(text) {
  const telPhones = [...document.querySelectorAll('a[href^="tel:"]')]
    .map((link) => normalizePhone(link.href.replace("tel:", "")))
    .filter(Boolean)

  const textPhones = findLabeledPhones(text)

  return unique([...telPhones, ...textPhones]).slice(0, 5)
}

function findLabeledPhones(text) {
  const phoneMatches = []
  const labeledPhonePattern = /(?:phone|mobile|tel|telephone|contact|call|whatsapp)\s*:?\s*(\+?\d[\d\s().-]{7,}\d)/gi
  let match = labeledPhonePattern.exec(text)

  while (match) {
    const phone = normalizePhone(match[1])

    if (phone) {
      phoneMatches.push(phone)
    }

    match = labeledPhonePattern.exec(text)
  }

  return phoneMatches
}

function normalizePhone(value) {
  const cleanValue = String(value || "").trim()
  const digits = cleanValue.replace(/\D/g, "")

  if (digits.length < 10 || digits.length > 15) {
    return ""
  }

  if (/(\d)\1{7,}/.test(digits)) {
    return ""
  }

  return cleanValue
}

function findLinks() {
  return [...document.querySelectorAll("a[href]")]
    .map((link) => ({
      text: cleanText(link.innerText).slice(0, 80),
      href: link.href
    }))
    .filter((link) => link.href.startsWith("http"))
}

function findHeadings() {
  return textFromSelectors("h1,h2,h3")
    .map(cleanText)
    .filter(Boolean)
}

function findSections() {
  const sections = []
  const mainContent = document.querySelector("main, article, [role='main']")
  const targets = mainContent ? [mainContent] : document.querySelectorAll("main, article, section")
  
  targets.forEach((container) => {
    const text = cleanText(container.innerText)
    if (text.length >= 40 && text.length <= 5000) {
      sections.push(text)
    }
  })
  
  return sections
}

function textFromSelectors(selector) {
  return [...document.querySelectorAll(selector)]
    .map((element) => element.innerText?.trim() || "")
    .filter(Boolean)
}

function cleanText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}
