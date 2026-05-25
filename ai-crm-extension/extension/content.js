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

// ─────────────────────────────────────────────
// PHASE ORCHESTRATOR
// ─────────────────────────────────────────────

async function preparePageForScraping() {
  // Phase 1: scroll to trigger lazy loading
  await scrollForLazyContent()
  window.scrollTo({ top: 0, behavior: "instant" })
  await wait(300)

  // Phase 2: click all expandable buttons
  const clickCount = await clickAllExpandableButtons()

  if (clickCount > 0) {
    // Wait longer — LinkedIn does network requests after button clicks
    await waitForExpandedContent()
    await wait(500)
  }

  // Phase 3: scroll again to load any newly revealed content
  await scrollForLazyContent()
  await wait(400)

  // Phase 4: back to top for extraction
  window.scrollTo({ top: 0, behavior: "instant" })
  await wait(200)
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
// CLICK EXPANDABLE BUTTONS
// ─────────────────────────────────────────────

async function clickAllExpandableButtons() {
  // What we WANT to click
  const safePatterns = [
    /show\s*all/i,       // "Show all 12 skills"
    /see\s*all/i,        // "See all experiences"
    /show\s*more/i,      // "Show more"
    /see\s*more/i,       // "See more"
    /view\s*more/i,      // "View more"
    /load\s*more/i,      // "Load more"
    /expand/i,           // "Expand"
    /read\s*more/i,      // "Read more"
    /^more$/i            // Just "more"
  ]

  // What we NEVER click — social / destructive actions
  const dangerousPatterns = [
    /follow/i, /connect/i, /message/i, /like/i,
    /share/i,  /apply/i,   /submit/i,  /join/i,
    /subscribe/i, /sign\s*in/i, /log\s*in/i,
    /login/i, /register/i, /next/i, /accept/i,
    /reject/i, /buy/i, /download/i,
    /comment/i,  /repost/i, /invite/i,
    /save/i, /send/i, /post/i, /delete/i,
    /react/i, /emoji/i, /report/i, /block/i,
    /dismiss/i, /close/i, /cancel/i
  ]

  function getButtonText(el) {
    return (
      el.innerText?.trim() ||
      el.getAttribute("aria-label")?.trim() ||
      el.getAttribute("title")?.trim() ||
      ""
    )
  }

  function isSafe(el) {
    const text = getButtonText(el).toLowerCase()
    if (!text) return false
    const safe      = safePatterns.some(p => p.test(text))
    const dangerous = dangerousPatterns.some(p => p.test(text))
    return safe && !dangerous && isVisible(el)
  }

  // ── Collect safe buttons ──
  const candidates = [
    ...document.querySelectorAll("button"),
    ...document.querySelectorAll("a[href]"),
    ...document.querySelectorAll("[role='button']"),
    ...document.querySelectorAll("[aria-expanded='false']")
  ]

  const toClick = []
  const seen    = new Set()

  for (const el of candidates) {
    if (!seen.has(el) && isSafe(el)) {
      seen.add(el)
      toClick.push(el)
    }
  }

  // ── Click each one with real mouse events ──
  // Raw .click() is blocked by LinkedIn's React event system
  // dispatchEvent with MouseEvent bypasses that
  let clicked = 0

  for (const el of toClick) {
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }))
      el.dispatchEvent(new MouseEvent("click",     { bubbles: true, cancelable: true }))
      clicked++
      await wait(200) // small gap so LinkedIn doesn't ignore rapid clicks
    } catch (err) {
      // Ignore failed expansion clicks so scraping can continue.
    }
  }

  return clicked
}

// ─────────────────────────────────────────────
// WAIT FOR EXPANDED CONTENT TO SETTLE
// ─────────────────────────────────────────────

async function waitForExpandedContent() {
  const maxWait       = 5000  // increased — LinkedIn does network calls
  const settleDuration = 800  // increased — wait longer for content to stop changing
  let lastMutationTime = Date.now()
  let mutationCount    = 0

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      observer.disconnect()
      resolve(false)
    }, maxWait)

    const observer = new MutationObserver(() => {
      mutationCount++
      lastMutationTime = Date.now()
    })

    observer.observe(document.body, {
      childList:     true,
      subtree:       true,
      attributes:    false,
      characterData: false
    })

    const checkSettled = setInterval(() => {
      if (Date.now() - lastMutationTime >= settleDuration) {
        clearInterval(checkSettled)
        clearTimeout(timeout)
        observer.disconnect()
        resolve(true)
      }
    }, 100)
  })
}

// ─────────────────────────────────────────────
// BUILD RAW PROFILE
// ─────────────────────────────────────────────

async function buildRawProfile() {
  const sourceUrl      = window.location.href
  const sourceHost     = window.location.hostname.replace(/^www\./, "")
  const fullVisibleText = cleanText(document.body.innerText)
  const visibleText    = fullVisibleText
  const imageCandidates = findImageCandidates()

  return {
    source_platform:  sourceHost,
    source_url:       sourceUrl,
    source_host:      sourceHost,
    extracted_at:     new Date().toISOString(),
    page_title:       document.title,
    meta:             getMetaData(),
    candidate_name:   findBestNameCandidate(),
    candidate_description: findBestDescriptionCandidate(),
    candidate_image:  imageCandidates[0]?.src || "",
    image_candidates: imageCandidates,
    emails:           findEmails(visibleText),
    phones:           findPhones(visibleText),
    links:            findLinks(),
    headings:         findHeadings(),
    sections:         findSections(),
    skills_sections: findLabeledSections(["skills", "skill"]),
    experience_sections: findLabeledSections(["experience", "experiences"]),
    education_sections: findLabeledSections(["education"]),
    certification_sections: findLabeledSections(["certifications", "certification", "licenses"]),
    projects_sections: findLabeledSections(["projects", "project"]),
    contact_links: findContactLinks(),
    social_links: findSocialLinks(),
    visible_text:     visibleText
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

  document.querySelectorAll("h1,h2,h3,h4").forEach(heading => {
    const headingText = cleanText(heading.innerText || "")
    const headingKey = headingText.toLowerCase()

    if (!normalizedLabels.some(label => headingKey.includes(label))) {
      return
    }

    const container = findUsefulSectionContainer(heading, headingText)
    const text = cleanText(container?.innerText || "")

    if (text.length >= 20) {
      sections.push(text)
    }
  })

  return unique(sections).slice(0, 10)
}

function findUsefulSectionContainer(heading, headingText) {
  let current = heading.parentElement

  while (current && current !== document.body) {
    const text = cleanText(current.innerText || "")

    if (text.length > headingText.length + 80) {
      return current
    }

    current = current.parentElement
  }

  return heading.closest("section, article, main, div") || heading.parentElement
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

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
