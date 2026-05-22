require("dotenv").config()

const crypto = require("crypto")

const express = require("express")
const cors = require("cors")

const app = express()
const PORT = 3000
const OPENAI_MODEL = process.env.OPENAI_MODEL
const DIRECT_MAP_CHAR_LIMIT = 8000
const CHUNK_CHAR_LIMIT = 5000

app.use(cors())
app.use(express.json({ limit: "10mb" }))

app.get("/", (req, res) => {
  res.send("Backend is running")
})

app.post("/map-profile", async (req, res) => {
  const rawProfile = req.body

  if (!rawProfile || typeof rawProfile !== "object") {
    res.status(400).json({
      success: false,
      error: "Raw profile data is required"
    })
    return
  }

  try {
    const mappedProfile = process.env.OPENAI_API_KEY
      ? await mapWithOpenAI(rawProfile)
      : mapWithoutAi(rawProfile)

    res.json({
      success: true,
      data: mappedProfile
    })
  } catch (error) {
    console.error("AI mapping error:", error.message)

    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.post("/extract", (req, res) => {
  console.log("\n===== RECEIVED DATA =====")
  console.log(JSON.stringify(req.body, null, 2))

  res.json({
    success: true,
    message: "Data printed successfully"
  })
})

async function mapWithOpenAI(rawProfile) {
  const chunks = createProfileMappingChunks(rawProfile)
  const mappedChunks = []

  for (const chunk of chunks) {
    mappedChunks.push(await mapChunkWithOpenAI(chunk, chunks.length))
  }

  if (mappedChunks.length === 1) {
    return normalizeMappedProfile(mappedChunks[0], rawProfile)
  }

  return mergeMappedProfiles(mappedChunks, rawProfile)
}

async function mapChunkWithOpenAI(rawProfileChunk, totalChunks) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You are ProfileScraper AI, a STRICT data extraction engine. Accuracy over completeness.",
                "Extract ONLY explicit, verifiable facts from raw profile data. Map into the CRM JSON schema.",
                "Return ONLY valid JSON with no markdown, explanations, or commentary.",
                "⚠️ CRITICAL RULES:",
                "1. If data is not explicitly present, leave fields EMPTY. Do not guess, infer, or fill from context.",
                "2. Use empty strings (\"\") for unknown text fields and empty arrays ([]) for unknown lists.",
                "3. Ignore: navigation, buttons, ads, boilerplate, social proof, recommendations, engagement metrics.",
                "4. Ignore: logged-in user data, account dropdowns, sidebar ads, unrelated profiles.",
                "5. Extract ONLY the main profile subject from the source_url, not adjacent people.",
                "6. For contact_info.email: Extract ONLY from explicit email addresses (mailto: links or common email domain patterns). Reject if ambiguous.",
                "7. For contact_info.phone: Extract ONLY from tel: links or explicit labels (\"Phone:\", \"Mobile:\", \"Call:\"). Reject strings without clear context.",
                "8. For personal_info.profile_photo_url: Use ONLY images clearly tagged as profile/avatar/person photos. Reject if ambiguous.",
                "9. For skills/education/experience/projects: Extract ONLY if clearly labeled and describing the MAIN subject, not examples or references.",
                "10. Remove exact duplicates within each array field.",
                "CONTEXT: This may be one chunk of multiple. Return only facts from THIS chunk. Do not assume data from other chunks."
              ].join(" ")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                instruction: "Map this raw profile chunk into the schema. This may be one chunk from a larger page.",
                total_chunks: totalChunks,
                raw_profile_chunk: rawProfileChunk
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "profile_scraper_schema",
          strict: true,
          schema: PROFILE_JSON_SCHEMA
        }
      }
    })
  })

  const result = await response.json()

  if (!response.ok) {
    throw new Error(result.error?.message || "OpenAI request failed")
  }

  const outputText = result.output_text || extractOutputText(result)

  if (!outputText) {
    throw new Error("OpenAI returned no JSON output")
  }

  return JSON.parse(outputText)
}

function extractOutputText(result) {
  return result.output
    ?.flatMap((item) => item.content || [])
    ?.find((content) => content.type === "output_text")
    ?.text
}

function createProfileMappingChunks(rawProfile) {
  const compactProfile = compactRawProfile(rawProfile)

  if (JSON.stringify(compactProfile).length <= DIRECT_MAP_CHAR_LIMIT) {
    return [compactProfile]
  }

  const baseProfile = {
    ...compactProfile,
    links: [],
    sections: [],
    expanded_pages: [],
    visible_text: "",
    content_chunks: []
  }

  const pieces = [
    ...createLinkPieces(compactProfile.links || []),
    ...createTextPieces("section", compactProfile.sections || []),
    ...createExpandedPagePieces(compactProfile.expanded_pages || []),
    ...splitText(compactProfile.visible_text || "", CHUNK_CHAR_LIMIT).map((text, index) => ({
      type: "visible_text",
      index,
      text
    }))
  ].filter((piece) => piece.text || piece.links?.length)

  if (pieces.length === 0) {
    return [baseProfile]
  }

  const chunks = []
  let currentPieces = []

  for (const piece of pieces) {
    const candidatePieces = [...currentPieces, piece]
    const candidate = {
      ...baseProfile,
      content_chunks: candidatePieces
    }

    if (JSON.stringify(candidate).length > DIRECT_MAP_CHAR_LIMIT && currentPieces.length > 0) {
      chunks.push({
        ...baseProfile,
        chunk_index: chunks.length,
        content_chunks: currentPieces
      })
      currentPieces = [piece]
    } else {
      currentPieces = candidatePieces
    }
  }

  if (currentPieces.length > 0) {
    chunks.push({
      ...baseProfile,
      chunk_index: chunks.length,
      content_chunks: currentPieces
    })
  }

  return chunks.map((chunk) => ({
    ...chunk,
    total_chunks: chunks.length
  }))
}

function compactRawProfile(rawProfile) {
  return {
    source_platform: rawProfile.source_platform || "",
    source_url: rawProfile.source_url || "",
    source_host: rawProfile.source_host || "",
    extracted_at: rawProfile.extracted_at || new Date().toISOString(),
    page_title: rawProfile.page_title || "",
    meta: rawProfile.meta || {},
    candidate_name: rawProfile.candidate_name || "",
    candidate_description: rawProfile.candidate_description || "",
    candidate_image: rawProfile.candidate_image || "",
    image_candidates: rawProfile.image_candidates || [],
    emails: rawProfile.emails || [],
    phones: rawProfile.phones || [],
    links: dedupeLinks(rawProfile.links || []),
    headings: uniqueStrings(rawProfile.headings || []),
    sections: uniqueStrings(rawProfile.sections || []),
    expanded_pages: rawProfile.expanded_pages || [],
    visible_text: rawProfile.visible_text || ""
  }
}

function createLinkPieces(links) {
  const pieces = []
  let currentLinks = []

  for (const link of links) {
    const nextLinks = [...currentLinks, link]
    const text = JSON.stringify(nextLinks)

    if (text.length > 3500 && currentLinks.length > 0) {
      pieces.push({
        type: "links",
        index: pieces.length,
        links: currentLinks
      })
      currentLinks = [link]
    } else {
      currentLinks = nextLinks
    }
  }

  if (currentLinks.length > 0) {
    pieces.push({
      type: "links",
      index: pieces.length,
      links: currentLinks
    })
  }

  return pieces
}

function createTextPieces(type, values) {
  return values.flatMap((value, index) =>
    splitText(value, CHUNK_CHAR_LIMIT).map((text, partIndex) => ({
      type,
      index,
      part_index: partIndex,
      text
    }))
  )
}

function createExpandedPagePieces(pages) {
  return pages.flatMap((page, index) => {
    const pageText = [
      page.title,
      ...(page.headings || []),
      ...(page.sections || []),
      page.text
    ].filter(Boolean).join("\n")

    return splitText(pageText, CHUNK_CHAR_LIMIT).map((text, partIndex) => ({
      type: "expanded_page",
      index,
      part_index: partIndex,
      trigger_text: page.trigger_text || "",
      url: page.url || "",
      text
    }))
  })
}

function splitText(text, maxLength) {
  const cleanValue = String(text || "").trim()

  if (!cleanValue) {
    return []
  }

  const chunks = []
  let cursor = 0

  while (cursor < cleanValue.length) {
    let end = Math.min(cursor + maxLength, cleanValue.length)

    if (end < cleanValue.length) {
      const sentenceBreak = cleanValue.lastIndexOf(". ", end)
      const spaceBreak = cleanValue.lastIndexOf(" ", end)
      const breakAt = sentenceBreak > cursor + 1000 ? sentenceBreak + 1 : spaceBreak

      if (breakAt > cursor) {
        end = breakAt
      }
    }

    chunks.push(cleanValue.slice(cursor, end).trim())
    cursor = end
  }

  return chunks.filter(Boolean)
}

function mergeMappedProfiles(mappedProfiles, rawProfile) {
  const finalProfile = createEmptyProfile(rawProfile)

  for (const profile of mappedProfiles) {
    mergeTopLevelFields(finalProfile, profile)
    mergeObjectFields(finalProfile.personal_info, profile.personal_info || {}, {
      bio: "longest",
      headline: "longest",
      profile_photo_url: "first"
    })
    mergeObjectFields(finalProfile.contact_info, profile.contact_info || {})
    mergeObjectFields(finalProfile.organization, profile.organization || {})

    finalProfile.skills = uniqueStrings([...finalProfile.skills, ...(profile.skills || [])])
    finalProfile.languages = uniqueStrings([...finalProfile.languages, ...(profile.languages || [])])
    finalProfile.experience = dedupeObjects(
      [...finalProfile.experience, ...(profile.experience || [])],
      experienceKey
    )
    finalProfile.education = dedupeObjects(
      [...finalProfile.education, ...(profile.education || [])],
      educationKey
    )
    finalProfile.certifications = dedupeObjects(
      [...finalProfile.certifications, ...(profile.certifications || [])],
      certificationKey
    )
    finalProfile.projects = dedupeObjects(
      [...finalProfile.projects, ...(profile.projects || [])],
      projectKey
    )
  }

  return normalizeMappedProfile(finalProfile, rawProfile)
}

function normalizeMappedProfile(profile, rawProfile) {
  const normalizedProfile = {
    ...createEmptyProfile(rawProfile),
    ...profile,
    source_platform: profile.source_platform || rawProfile.source_platform || "",
    source_url: profile.source_url || rawProfile.source_url || "",
    extracted_at: profile.extracted_at || rawProfile.extracted_at || new Date().toISOString(),
    personal_info: {
      ...createEmptyProfile(rawProfile).personal_info,
      ...(profile.personal_info || {})
    },
    contact_info: {
      ...createEmptyProfile(rawProfile).contact_info,
      ...(profile.contact_info || {})
    },
    organization: {
      ...createEmptyProfile(rawProfile).organization,
      ...(profile.organization || {})
    },
    skills: uniqueStrings(profile.skills || []),
    experience: dedupeObjects(profile.experience || [], experienceKey),
    education: dedupeObjects(profile.education || [], educationKey),
    certifications: dedupeObjects(profile.certifications || [], certificationKey),
    languages: uniqueStrings(profile.languages || []),
    projects: dedupeObjects(profile.projects || [], projectKey)
  }

  normalizedProfile.contact_info.phone = rawProfile.phones?.[0] || ""

  return normalizedProfile
}

function createEmptyProfile(rawProfile = {}) {
  return {
    profile_id: createProfileId(rawProfile.source_url || rawProfile.candidate_name || ""),
    source_platform: rawProfile.source_platform || "",
    source_url: rawProfile.source_url || "",
    extracted_at: rawProfile.extracted_at || new Date().toISOString(),
    personal_info: {
      first_name: "",
      last_name: "",
      full_name: "",
      headline: "",
      job_title: "",
      bio: "",
      location: "",
      profile_photo_url: ""
    },
    contact_info: {
      email: "",
      phone: "",
      website: "",
      linkedin: "",
      github: "",
      twitter: ""
    },
    organization: {
      company_name: "",
      company_website: "",
      industry: "",
      company_size: "",
      company_location: ""
    },
    skills: [],
    experience: [],
    education: [],
    certifications: [],
    languages: [],
    projects: []
  }
}

function mergeTopLevelFields(target, source) {
  for (const key of ["profile_id", "source_platform", "source_url", "extracted_at"]) {
    if (!target[key] && source?.[key]) {
      target[key] = source[key]
    }
  }
}

function mergeObjectFields(target, source, strategies = {}) {
  for (const key of Object.keys(target)) {
    const sourceValue = source[key]

    if (!sourceValue) {
      continue
    }

    if (!target[key]) {
      target[key] = sourceValue
      continue
    }

    if (strategies[key] === "longest" && sourceValue.length > target[key].length) {
      target[key] = sourceValue
    }
  }
}

function dedupeLinks(links) {
  const seen = new Set()

  return links.filter((link) => {
    const key = normalizeKey(link.href || "")

    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function uniqueStrings(values) {
  const seen = new Set()
  const result = []

  for (const value of values) {
    const cleanValue = String(value || "").trim()
    const key = normalizeKey(cleanValue)

    if (!cleanValue || seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(cleanValue)
  }

  return result
}

function dedupeObjects(values, keyFn) {
  const seen = new Set()
  const result = []

  for (const value of values) {
    const key = normalizeKey(keyFn(value))

    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(value)
  }

  return result
}

function experienceKey(item) {
  return [
    item.company,
    item.role,
    item.start_date,
    item.end_date
  ].join("|")
}

function educationKey(item) {
  return [
    item.institution,
    item.degree,
    item.field_of_study,
    item.start_year,
    item.end_year
  ].join("|")
}

function certificationKey(item) {
  return [
    item.name,
    item.credential_id,
    item.issue_date
  ].join("|")
}

function projectKey(item) {
  return [
    item.project_name,
    item.project_url
  ].join("|")
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function mapWithoutAi(rawProfile) {
  const fullName = cleanName(rawProfile.candidate_name || rawProfile.page_title || "")
  const { firstName, lastName } = splitName(fullName)
  const linkedin = findLink(rawProfile.links, "linkedin.com")
  const github = findLink(rawProfile.links, "github.com")
  const twitter = findLink(rawProfile.links, "twitter.com") || findLink(rawProfile.links, "x.com")

  return {
    profile_id: createProfileId(rawProfile.source_url || fullName),
    source_platform: rawProfile.source_platform || "",
    source_url: rawProfile.source_url || "",
    extracted_at: rawProfile.extracted_at || new Date().toISOString(),
    personal_info: {
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      headline: "",
      job_title: "",
      bio: rawProfile.candidate_description || rawProfile.meta?.description || "",
      location: "",
      profile_photo_url: rawProfile.candidate_image || rawProfile.meta?.image || ""
    },
    contact_info: {
      email: rawProfile.emails?.[0] || "",
      phone: rawProfile.phones?.[0] || "",
      website: findWebsite(rawProfile.links, rawProfile.source_host),
      linkedin,
      github,
      twitter
    },
    organization: {
      company_name: "",
      company_website: "",
      industry: "",
      company_size: "",
      company_location: ""
    },
    skills: [],
    experience: [],
    education: [],
    certifications: [],
    languages: [],
    projects: []
  }
}

function cleanName(name) {
  return String(name)
    .replace(/\s+[|-]\s+.+$/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

function splitName(fullName) {
  const parts = fullName.split(" ").filter(Boolean)

  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" ")
  }
}

function createProfileId(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || Date.now()))
    .digest("hex")
    .slice(0, 16)
}

function findLink(links = [], matcher) {
  return links.find((link) => link.href?.includes(matcher))?.href || ""
}

function findWebsite(links = [], sourceHost = "") {
  return links.find((link) => {
    try {
      const host = new URL(link.href).hostname
      return sourceHost && host !== sourceHost
    } catch {
      return false
    }
  })?.href || ""
}

const experienceItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "company",
    "role",
    "employment_type",
    "location",
    "start_date",
    "end_date",
    "duration",
    "description",
    "technologies"
  ],
  properties: {
    company: { type: "string" },
    role: { type: "string" },
    employment_type: { type: "string" },
    location: { type: "string" },
    start_date: { type: "string" },
    end_date: { type: "string" },
    duration: { type: "string" },
    description: { type: "string" },
    technologies: {
      type: "array",
      items: { type: "string" }
    }
  }
}

const educationItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "institution",
    "degree",
    "field_of_study",
    "start_year",
    "end_year",
    "grade"
  ],
  properties: {
    institution: { type: "string" },
    degree: { type: "string" },
    field_of_study: { type: "string" },
    start_year: { type: "string" },
    end_year: { type: "string" },
    grade: { type: "string" }
  }
}

const certificationItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "issue_date",
    "expiry_date",
    "credential_id"
  ],
  properties: {
    name: { type: "string" },
    issue_date: { type: "string" },
    expiry_date: { type: "string" },
    credential_id: { type: "string" }
  }
}

const projectItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "project_name",
    "description",
    "technologies",
    "project_url"
  ],
  properties: {
    project_name: { type: "string" },
    description: { type: "string" },
    technologies: {
      type: "array",
      items: { type: "string" }
    },
    project_url: { type: "string" }
  }
}

const PROFILE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "profile_id",
    "source_platform",
    "source_url",
    "extracted_at",
    "personal_info",
    "contact_info",
    "organization",
    "skills",
    "experience",
    "education",
    "certifications",
    "languages",
    "projects"
  ],
  properties: {
    profile_id: { type: "string" },
    source_platform: { type: "string" },
    source_url: { type: "string" },
    extracted_at: { type: "string" },
    personal_info: {
      type: "object",
      additionalProperties: false,
      required: [
        "first_name",
        "last_name",
        "full_name",
        "headline",
        "job_title",
        "bio",
        "location",
        "profile_photo_url"
      ],
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        full_name: { type: "string" },
        headline: { type: "string" },
        job_title: { type: "string" },
        bio: { type: "string" },
        location: { type: "string" },
        profile_photo_url: { type: "string" }
      }
    },
    contact_info: {
      type: "object",
      additionalProperties: false,
      required: [
        "email",
        "phone",
        "website",
        "linkedin",
        "github",
        "twitter"
      ],
      properties: {
        email: { type: "string" },
        phone: { type: "string" },
        website: { type: "string" },
        linkedin: { type: "string" },
        github: { type: "string" },
        twitter: { type: "string" }
      }
    },
    organization: {
      type: "object",
      additionalProperties: false,
      required: [
        "company_name",
        "company_website",
        "industry",
        "company_size",
        "company_location"
      ],
      properties: {
        company_name: { type: "string" },
        company_website: { type: "string" },
        industry: { type: "string" },
        company_size: { type: "string" },
        company_location: { type: "string" }
      }
    },
    skills: {
      type: "array",
      items: { type: "string" }
    },
    experience: {
      type: "array",
      items: experienceItemSchema
    },
    education: {
      type: "array",
      items: educationItemSchema
    },
    certifications: {
      type: "array",
      items: certificationItemSchema
    },
    languages: {
      type: "array",
      items: { type: "string" }
    },
    projects: {
      type: "array",
      items: projectItemSchema
    }
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
