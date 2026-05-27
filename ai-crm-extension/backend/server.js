require("dotenv").config({ silent: true })

const crypto = require("crypto")

const express = require("express")
const cors = require("cors")

const app = express()
const PORT = 3000
const OPENAI_MODEL = process.env.OPENAI_MODEL
const DIRECT_MAP_CHAR_LIMIT = 100000
const CHUNK_CHAR_LIMIT = 50000

app.use(cors())
app.use(express.json({ limit: "10mb" }))

app.get("/", (req, res) => {
  res.send("Backend is running")
})

app.post("/scrape/parse-text", async (req, res) => {
  const rawProfile = req.body

  if (!rawProfile || typeof rawProfile !== "object") {
    res.status(400).json({
      success: false,
      error: "Raw profile data is required"
    })
    return
  }

  try {
    const mappedProfile = hasOpenAiKey()
      ? await mapWithOpenAI(rawProfile)
      : mapWithoutAi(rawProfile)

    res.json({
      success: true,
      data: mappedProfile
    })
  } catch (error) {
    console.error("Text parsing error:", error.message)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.post("/scrape/parse-image", async (req, res) => {
  const { screenshots, missingFields, textResult } = req.body

  if (!screenshots || !missingFields || !textResult) {
    res.status(400).json({
      success: false,
      error: "Screenshots, missing fields, and text result are required"
    })
    return
  }

  try {
    const visionExtraction = await extractWithVisionAPI(screenshots, missingFields)
    const mergedProfile = mergeMissingFields(textResult, visionExtraction)

    res.json({
      success: true,
      data: mergedProfile
    })
  } catch (error) {
    console.error("Vision parsing error:", error.message)
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
  const mappedProfile = await mapRawProfileDirectly(rawProfile)
  return normalizeMappedProfile(mappedProfile, rawProfile)
}

async function extractWithVisionAPI(screenshots, missingFields) {
  if (screenshots.length === 0) {
    throw new Error("No screenshots provided")
  }
  
  // Prepare image inputs for OpenAI
  const imageInputs = screenshots.map(screenshot => ({
    type: "image_url",
    image_url: {
      url: screenshot.dataUrl,
      detail: "high"  // Use "high" for better OCR
    }
  }))
  
  const systemPrompt = `You are a LinkedIn profile data extractor. You will receive ${screenshots.length} screenshots from different parts of a LinkedIn profile page.

CRITICAL INSTRUCTIONS:
1. Look at ALL ${screenshots.length} images - they show different sections of the same profile
2. Extract EVERY entry you see across all images
3. Combine information from all screenshots into one complete profile

EXPERIENCE - Extract ALL jobs you see across all images:
- company_name: Company name
- position: Job title/role  
- location: Location (empty string if not visible)
- service_period: Full date range (e.g., "Feb 2014 - Present · 12 yrs")

EDUCATION - Extract ALL schools you see across all images:
- institution: School/University name
- degree: Degree name
- field: Field of study
- graduationDate: Year range (e.g., "2010 – 2014")

SKILLS - Extract ALL skills you see across all images:
- skill_name: Skill name

CERTIFICATES - Extract ALL certificates:
- name: Certificate name
- issuedDate: Issue date
- expiryDate: Expiry date (empty if none)

LANGUAGES - Extract ALL languages as strings

Scan ALL ${screenshots.length} images carefully and return complete structured data.`

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: [
            { 
              type: "text", 
              text: `Extract ALL profile data from these ${screenshots.length} LinkedIn screenshots. Each image shows a different part of the profile. Combine all information into one complete profile.`
            },
            ...imageInputs
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "recruiter_candidate_schema",
          strict: true,
          schema: PROFILE_JSON_SCHEMA
        }
      },
      max_tokens: 4000
    })
  })
  
  const result = await response.json()
  
  if (!response.ok) {
    console.error("❌ Vision API Error:", result)
    throw new Error(result.error?.message || "Vision API failed")
  }
  
  const outputText = result.choices?.[0]?.message?.content
  if (!outputText) {
    throw new Error("No content in vision API response")
  }
  
  const extracted = JSON.parse(outputText)
  return extracted
}

function mergeMissingFields(textBased, visionBased) {
  const merged = { ...textBased }
  
  // Merge only missing fields from vision
  if (!merged.parsedExperience || merged.parsedExperience.length === 0) {
    merged.parsedExperience = visionBased.parsedExperience || []
  }
  
  if (!merged.parsedEducation || merged.parsedEducation.length === 0) {
    merged.parsedEducation = visionBased.parsedEducation || []
    merged.university = visionBased.university || ""
    merged.diploma = visionBased.diploma || ""
    merged.graduationDate = visionBased.graduationDate || ""
  }
  
  if (!merged.parsedSkills || merged.parsedSkills.length === 0) {
    merged.parsedSkills = visionBased.parsedSkills || []
  }
  
  if (merged.yearsOfExperience === 0 && visionBased.yearsOfExperience > 0) {
    merged.yearsOfExperience = visionBased.yearsOfExperience
  }
  
  return merged
}

function extractOutputText(result) {
  return result.output
    ?.flatMap((item) => item.content || [])
    ?.find((content) => content.type === "output_text")
    ?.text
}

async function mapRawProfileDirectly(rawProfile) {
  const fullText = rawProfile.visible_text || ""
  
  const systemPrompt = `You are a professional profile data extraction AI. Extract ALL information and map to schema.

CRITICAL: When you see multiple entries (multiple jobs, multiple schools, multiple skills), you MUST extract ALL of them into arrays.

EXAMPLE OF CORRECT EXTRACTION:
If text contains:
"Experience
Founder and CEO
NVIDIA
1993 - Present · 33 yrs 5 mos

Dishwasher, Busboy, Waiter
Denny's · Seasonal
1978 - 1983 · 5 yrs"

You MUST return:
"parsedExperience": [
  {"company_name": "NVIDIA", "position": "Founder and CEO", "location": "", "service_period": "1993 - Present · 33 yrs 5 mos"},
  {"company_name": "Denny's", "position": "Dishwasher, Busboy, Waiter", "location": "", "service_period": "1978 - 1983 · 5 yrs"}
]

If text contains:
"Education
Stanford University
MSEE
1990 – 1992

Oregon State University
BSEE
1980 – 1984"

You MUST return:
"parsedEducation": [
  {"institution": "Stanford University", "degree": "MSEE", "field": "", "graduationDate": "1990 – 1992"},
  {"institution": "Oregon State University", "degree": "BSEE", "field": "", "graduationDate": "1980 – 1984"}
]

If text contains:
"Skills
Management
Endorsed by 43 colleagues
Leadership
Communication"

You MUST return:
"parsedSkills": [
  {"skill_name": "Management"},
  {"skill_name": "Leadership"},
  {"skill_name": "Communication"}
]

SCHEMA FIELDS:
- firstName, lastName: From profile name
- linkedInUrl: From source URL
- title: Current job title
- currentPosition: Same as title
- location: Person's location
- currentCompany: Current company name
- bio: About section
- profilePhotoUrl: From metadata
- parsedExperience: ARRAY of ALL jobs
- parsedEducation: ARRAY of ALL schools
- parsedSkills: ARRAY of ALL skills
- parsedCertificates: ARRAY of ALL certifications
- languages: ARRAY of ALL languages
- email, phone, skype, otherContact: Contact info
- parsedSocialMedia: Social media URLs
- yearsOfExperience: Number calculated from experience
- source: "extension"
- visibility: "private"
- university, diploma, graduationDate: Most recent education
- createdBy, companyId, salary, noticePeriod, nationality, birthdate, gender: Empty strings

TEXT TO EXTRACT FROM:
${fullText}

Extract EVERY entry you find. Do not stop after one.`

  return requestOpenAIJson({
    schemaName: "recruiter_candidate_schema",
    schema: PROFILE_JSON_SCHEMA,
    systemText: systemPrompt,
    userPayload: {
      instruction: "Extract ALL data. Return arrays with ALL entries found.",
      source_url: rawProfile.source_url || "",
      profilePhotoUrl: rawProfile.candidate_image || rawProfile.meta?.image || ""
    }
  })
}

async function extractPartialChunkWithOpenAI(rawProfileChunk, totalChunks) {
  // Extract the actual text content to send directly in the prompt
  let fullText = ""
  
  if (rawProfileChunk.content_chunks) {
    console.log(`🤖 Sending to AI: ${rawProfileChunk.content_chunks.length} content chunks`)
    
    rawProfileChunk.content_chunks.forEach((chunk, idx) => {
      const length = chunk.text?.length || chunk.links?.length || 0
      console.log(`  Chunk ${idx}: type=${chunk.type}, length=${length}`)
      
      if (chunk.text) {
        fullText += `\n\n=== ${chunk.type.toUpperCase()} ===\n${chunk.text}`
      }
    })
  }
  
  // Add visible_text if present
  if (rawProfileChunk.visible_text) {
    fullText += `\n\n=== FULL PAGE TEXT ===\n${rawProfileChunk.visible_text}`
  }
  
  console.log(`\n📄 Total text being sent to AI: ${fullText.length} chars\n`)
  
  const systemPrompt = `You are ProfileScraper AI. Extract ALL profile data.

CRITICAL: Extract EVERY SINGLE entry. Do NOT stop after one.

EXPERIENCE - Extract ALL jobs:
Format: {company_name, position, location, service_period}
Look for: Company name + Job title + Date range
Example: "NVIDIA" + "Founder and CEO" + "1993 - Present"
Example: "Denny's" + "Dishwasher, Busboy, Waiter" + "1978 - 1983"

EDUCATION - Extract ALL schools:
Format: {institution, degree, field, graduationDate}
Look for: School name + Degree + Years
Example: "Stanford University" + "MSEE" + "1990 – 1992"
Example: "Oregon State University" + "BSEE" + "1980 – 1984"

SKILLS - Extract ALL skills:
Look for: Technical skills, tools, frameworks, soft skills
Example: "Management", "Leadership", "Python", "Java"

LANGUAGES - Extract ALL languages:
Example: "English", "Spanish", "Chinese"

SCAN THE ENTIRE TEXT BELOW. Extract EVERYTHING.

TEXT TO ANALYZE:
${fullText}

Return JSON with: profile_summary, contact_info, organization, skills, experience, education, certifications, languages, projects, links`

  return requestOpenAIJson({
    schemaName: "profile_scraper_partial_extraction",
    schema: PARTIAL_EXTRACTION_SCHEMA,
    systemText: systemPrompt,
    userPayload: {
      instruction: "Extract ALL entries from the text above. Do not skip any."
    }
  })
}

function hasOpenAiKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || "").trim())
}

async function mapMergedExtractionWithOpenAI(mergedExtraction, rawProfile) {
  return requestOpenAIJson({
    schemaName: "recruiter_candidate_schema",
    schema: PROFILE_JSON_SCHEMA,
    systemText: [
      "You are RecruiterAI, a candidate profile mapper for recruiter CRM systems.",
      "Map extracted profile facts into the RECRUITER CANDIDATE schema (firstName, lastName, title, parsedExperience, etc.).",
      "Use ONLY facts present in merged_extraction and raw_profile_summary. Do not use outside knowledge.",
      "Field mapping rules:",
      "  - firstName, lastName: From profile_summary.first_name, last_name (split if needed)",
      "  - linkedInUrl: From source_url if LinkedIn, else empty",
      "  - title: From profile_summary.headline or job_title",
      "  - currentPosition: Same as title/current role when visible",
      "  - location: From profile_summary.location",
      "  - currentCompany: From organization.company_name (top of experience list if available)",
      "  - bio: From profile_summary.bio",
      "  - profilePhotoUrl: From profile_summary.profile_photo_url",
      "  - parsedExperience: Array of {company_name, position, location, service_period} from experience items",
      "  - parsedEducation: Array of {institution, degree, field, graduationDate} from education items",
      "  - university, diploma, graduationDate: From the top education item",
      "  - parsedSkills: Array of {skill_name} from skills (remove duplicates)",
      "  - parsedCertificates: Array of {name, issuedDate, expiryDate} from certifications",
      "  - languages: Array of language strings",
      "  - email, phone, skype, otherContact: From contact_info (not from visible_text guessing)",
      "  - parsedSocialMedia: {linkedin, twitter, github, facebook, instagram} URLs from contact_info or extracted links",
      "  - yearsOfExperience: Computed as number from experience dates, or 0 if not determinable",
      "  - source: Always 'extension'",
      "  - visibility: Always 'private'",
      "  - createdBy, companyId: Leave empty (recruiter fills later)",
      "  - salary, noticePeriod, nationality, birthdate, gender: Leave empty unless explicitly visible",
      "If a field has no data, use empty string, empty array, or 0 as appropriate.",
      "Return ONLY valid JSON. No markdown, explanations, or commentary."
    ].join(" "),
    userPayload: {
      instruction: "Map merged facts into the recruiter candidate schema. Extract data as-is, do not infer.",
      raw_profile_summary: createRawProfileSummary(rawProfile),
      merged_extraction: mergedExtraction
    }
  })
}

async function requestOpenAIJson({ schemaName, schema, systemText, userPayload }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: systemText
        },
        {
          role: "user",
          content: JSON.stringify(userPayload)
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema
        }
      }
    })
  })

  const result = await response.json()

  if (!response.ok) {
    console.error("OpenAI API Error:", result)
    throw new Error(result.error?.message || "OpenAI request failed")
  }

  const outputText = result.choices?.[0]?.message?.content

  if (!outputText) {
    throw new Error("OpenAI returned no JSON output")
  }

  return JSON.parse(outputText)
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
    skills_sections: [],
    experience_sections: [],
    education_sections: [],
    certification_sections: [],
    projects_sections: [],
    languages_sections: [],
    contact_links: [],
    social_links: [],
    structured_data: {},
    local_extraction: {},
    confidence: {},
    distilled_text: "",
    expanded_pages: [],
    visible_text: "",
    content_chunks: []
  }

  const pieces = [
    ...createLinkPieces(compactProfile.links || []),
    ...createLinkPieces(compactProfile.contact_links || []).map((piece) => ({
      ...piece,
      type: "contact_links"
    })),
    ...createLinkPieces(compactProfile.social_links || []).map((piece) => ({
      ...piece,
      type: "social_links"
    })),
    ...createTextPieces("skills_section", compactProfile.skills_sections || []),
    ...createTextPieces("experience_section", compactProfile.experience_sections || []),
    ...createTextPieces("education_section", compactProfile.education_sections || []),
    ...createTextPieces("certification_section", compactProfile.certification_sections || []),
    ...createTextPieces("projects_section", compactProfile.projects_sections || []),
    ...createTextPieces("languages_section", compactProfile.languages_sections || []),
    ...createTextPieces("section", compactProfile.sections || []),
    ...createExpandedPagePieces(compactProfile.expanded_pages || []),
    ...splitText(compactProfile.distilled_text || compactProfile.visible_text || "", CHUNK_CHAR_LIMIT).map((text, index) => ({
      type: compactProfile.distilled_text ? "distilled_text" : "visible_text",
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
    structured_data: rawProfile.structured_data || {},
    candidate_name: rawProfile.candidate_name || "",
    candidate_description: rawProfile.candidate_description || "",
    candidate_image: rawProfile.candidate_image || "",
    image_candidates: rawProfile.image_candidates || [],
    emails: rawProfile.emails || [],
    phones: rawProfile.phones || [],
    links: dedupeLinks(rawProfile.links || []),
    headings: uniqueStrings(rawProfile.headings || []),
    sections: uniqueStrings(rawProfile.sections || []),
    skills_sections: uniqueStrings(rawProfile.skills_sections || []),
    experience_sections: uniqueStrings(rawProfile.experience_sections || []),
    education_sections: uniqueStrings(rawProfile.education_sections || []),
    certification_sections: uniqueStrings(rawProfile.certification_sections || []),
    projects_sections: uniqueStrings(rawProfile.projects_sections || []),
    languages_sections: uniqueStrings(rawProfile.languages_sections || []),
    contact_links: dedupeLinks(rawProfile.contact_links || []),
    social_links: dedupeLinks(rawProfile.social_links || []),
    local_extraction: rawProfile.local_extraction || {},
    confidence: rawProfile.confidence || {},
    distilled_text: rawProfile.distilled_text || "",
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

function mergePartialExtractions(partialExtractions, rawProfile) {
  const merged = createEmptyPartialExtraction()

  for (const partial of partialExtractions) {
    mergeObjectFields(merged.profile_summary, partial.profile_summary || {}, {
      bio: "longest",
      headline: "longest",
      profile_photo_url: "first"
    })
    mergeObjectFields(merged.contact_info, partial.contact_info || {})
    mergeObjectFields(merged.organization, partial.organization || {})

    merged.skills = uniqueStrings([...merged.skills, ...(partial.skills || [])])
    merged.languages = uniqueStrings([...merged.languages, ...(partial.languages || [])])
    merged.experience = dedupeObjects(
      [...merged.experience, ...(partial.experience || [])],
      experienceKey
    )
    merged.education = dedupeObjects(
      [...merged.education, ...(partial.education || [])],
      educationKey
    )
    merged.certifications = dedupeObjects(
      [...merged.certifications, ...(partial.certifications || [])],
      certificationKey
    )
    merged.projects = dedupeObjects(
      [...merged.projects, ...(partial.projects || [])],
      projectKey
    )
    merged.links = dedupeLinks([...merged.links, ...(partial.links || [])])
  }

  merged.contact_info.email = rawProfile.emails?.[0] || merged.contact_info.email
  merged.contact_info.phone = rawProfile.phones?.[0] || ""

  return merged
}

function createEmptyPartialExtraction() {
  return {
    profile_summary: {
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
    projects: [],
    links: []
  }
}

function createRawProfileSummary(rawProfile) {
  return {
    source_platform: rawProfile.source_platform || "",
    source_url: rawProfile.source_url || "",
    source_host: rawProfile.source_host || "",
    extracted_at: rawProfile.extracted_at || new Date().toISOString(),
    page_title: rawProfile.page_title || "",
    meta: rawProfile.meta || {},
    structured_data: rawProfile.structured_data || {},
    candidate_name: rawProfile.candidate_name || "",
    candidate_description: rawProfile.candidate_description || "",
    candidate_image: rawProfile.candidate_image || "",
    image_candidates: rawProfile.image_candidates || [],
    emails: rawProfile.emails || [],
    phones: rawProfile.phones || [],
    contact_links: rawProfile.contact_links || [],
    social_links: rawProfile.social_links || [],
    local_extraction: rawProfile.local_extraction || {},
    confidence: rawProfile.confidence || {}
  }
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

  applyRecruiterFields(normalizedProfile, profile, rawProfile)
  applyVisibleTextMappings(normalizedProfile, rawProfile)
  normalizedProfile.contact_info.website = sanitizeWebsiteUrl(normalizedProfile.contact_info.website)
  normalizedProfile.contact_info.phone = rawProfile.phones?.[0] || ""

  return createCandidateSchemaProfile(normalizedProfile, rawProfile)
}

function validateSocialMediaLinks(socialMedia, allLinks) {
  // Helper function to check if URL matches platform
  const isLinkedIn = (url) => /linkedin\.com/i.test(url)
  const isTwitter = (url) => /(twitter\.com|x\.com)/i.test(url)
  const isGitHub = (url) => /github\.com/i.test(url)
  const isFacebook = (url) => /facebook\.com/i.test(url)
  const isInstagram = (url) => /instagram\.com/i.test(url)
  
  // Validate each field
  const validated = {
    linkedin: "",
    twitter: "",
    github: "",
    facebook: "",
    instagram: ""
  }
  
  // Validate LinkedIn
  if (socialMedia.linkedin && isLinkedIn(socialMedia.linkedin)) {
    validated.linkedin = socialMedia.linkedin
  } else if (socialMedia.linkedin) {
    // Wrong link in linkedin field, try to find correct one
    validated.linkedin = findLink(allLinks, "linkedin.com")
  } else {
    validated.linkedin = ""
  }
  
  // Validate Twitter
  if (socialMedia.twitter && isTwitter(socialMedia.twitter)) {
    validated.twitter = socialMedia.twitter
  } else if (socialMedia.twitter) {
    // Wrong link in twitter field, try to find correct one
    validated.twitter = findLink(allLinks, "twitter.com") || findLink(allLinks, "x.com")
  } else {
    validated.twitter = ""
  }
  
  // Validate GitHub
  if (socialMedia.github && isGitHub(socialMedia.github)) {
    validated.github = socialMedia.github
  } else if (socialMedia.github) {
    // Wrong link in github field, try to find correct one
    validated.github = findLink(allLinks, "github.com")
  } else {
    validated.github = ""
  }
  
  // Validate Facebook
  if (socialMedia.facebook && isFacebook(socialMedia.facebook)) {
    validated.facebook = socialMedia.facebook
  } else if (socialMedia.facebook) {
    // Wrong link in facebook field, try to find correct one
    validated.facebook = findLink(allLinks, "facebook.com")
  } else {
    validated.facebook = ""
  }
  
  // Validate Instagram
  if (socialMedia.instagram && isInstagram(socialMedia.instagram)) {
    validated.instagram = socialMedia.instagram
  } else if (socialMedia.instagram) {
    // Wrong link in instagram field, try to find correct one
    validated.instagram = findLink(allLinks, "instagram.com")
  } else {
    validated.instagram = ""
  }
  
  return validated
}

function createCandidateSchemaProfile(profile, rawProfile) {
  const personalInfo = profile.personal_info || {}
  const contactInfo = profile.contact_info || {}
  const socialMedia = profile.parsedSocialMedia || {}
  const firstName = profile.firstName || personalInfo.first_name || ""
  const lastName = profile.lastName || personalInfo.last_name || ""
  const linkedInUrl = profile.linkedInUrl || contactInfo.linkedin || findLink(rawProfile.links, "linkedin.com") ||
    (rawProfile.source_host === "linkedin.com" ? rawProfile.source_url : "")
  const parsedExperience = profile.parsedExperience || profile.experience || []
  const parsedEducation = profile.parsedEducation || profile.education || []
  const skills = profile.parsedSkills?.length
    ? profile.parsedSkills
    : uniqueStrings(profile.skills || []).map((skill) => ({ skill_name: skill }))
  const parsedCertificates = profile.parsedCertificates || profile.certifications || []
  const title = profile.title || personalInfo.job_title || personalInfo.headline || ""
  const topEducation = parsedEducation[0] || {}

  // Validate and categorize social media links
  const validatedSocialMedia = validateSocialMediaLinks({
    linkedin: linkedInUrl || socialMedia.linkedin || "",
    twitter: socialMedia.twitter || contactInfo.twitter || "",
    github: socialMedia.github || contactInfo.github || "",
    facebook: socialMedia.facebook || "",
    instagram: socialMedia.instagram || ""
  }, rawProfile.links || [])

  return {
    firstName,
    lastName,
    linkedInUrl: validatedSocialMedia.linkedin,
    title,
    currentPosition: profile.currentPosition || title,
    location: profile.location || personalInfo.location || "",
    currentCompany: profile.currentCompany || profile.organization?.company_name || parsedExperience[0]?.company_name || "",
    bio: profile.bio || personalInfo.bio || "",
    profilePhotoUrl: profile.profilePhotoUrl || personalInfo.profile_photo_url || "",
    parsedExperience,
    parsedEducation,
    university: profile.university || topEducation.institution || "",
    diploma: profile.diploma || topEducation.degree || "",
    graduationDate: profile.graduationDate || topEducation.graduationDate || "",
    parsedSkills: skills,
    parsedCertificates,
    languages: uniqueStrings(profile.languages || []),
    email: profile.email || contactInfo.email || rawProfile.emails?.[0] || "",
    phone: rawProfile.phones?.[0] || profile.phone || contactInfo.phone || "",
    skype: profile.skype || "",
    otherContact: profile.otherContact || "",
    parsedSocialMedia: validatedSocialMedia,
    yearsOfExperience: calculateYearsOfExperience(parsedExperience, profile.yearsOfExperience),
    source: "extension",
    visibility: profile.visibility || "private",
    createdBy: profile.createdBy || "",
    companyId: profile.companyId || "",
    salary: profile.salary || "",
    noticePeriod: profile.noticePeriod || "",
    nationality: profile.nationality || "",
    birthdate: profile.birthdate || "",
    gender: profile.gender || ""
  }
}

function applyRecruiterFields(normalizedProfile, profile, rawProfile) {
  const firstName = profile.firstName || normalizedProfile.personal_info.first_name
  const lastName = profile.lastName || normalizedProfile.personal_info.last_name
  const fullName = [firstName, lastName].filter(Boolean).join(" ")
  const socialMedia = profile.parsedSocialMedia || {}

  normalizedProfile.personal_info.first_name = firstName
  normalizedProfile.personal_info.last_name = lastName
  normalizedProfile.personal_info.full_name = normalizedProfile.personal_info.full_name || fullName
  normalizedProfile.personal_info.headline = profile.title || normalizedProfile.personal_info.headline
  normalizedProfile.personal_info.job_title = profile.title || normalizedProfile.personal_info.job_title
  normalizedProfile.personal_info.bio = profile.bio || normalizedProfile.personal_info.bio
  normalizedProfile.personal_info.location = profile.location || normalizedProfile.personal_info.location
  normalizedProfile.personal_info.profile_photo_url = profile.profilePhotoUrl || normalizedProfile.personal_info.profile_photo_url

  normalizedProfile.contact_info.email = profile.email || normalizedProfile.contact_info.email
  normalizedProfile.contact_info.website = normalizedProfile.contact_info.website || findWebsite(rawProfile.links, rawProfile.source_host)
  normalizedProfile.contact_info.linkedin = profile.linkedInUrl || socialMedia.linkedin || normalizedProfile.contact_info.linkedin
  normalizedProfile.contact_info.github = socialMedia.github || normalizedProfile.contact_info.github
  normalizedProfile.contact_info.twitter = socialMedia.twitter || normalizedProfile.contact_info.twitter

  normalizedProfile.organization.company_name = profile.currentCompany || normalizedProfile.organization.company_name

  if (profile.parsedSkills?.length) {
    normalizedProfile.skills = uniqueStrings(profile.parsedSkills.map((skill) => skill.skill_name || skill))
  }

  if (profile.parsedExperience?.length) {
    normalizedProfile.experience = profile.parsedExperience
  }

  if (profile.parsedEducation?.length) {
    normalizedProfile.education = profile.parsedEducation
  }

  if (profile.parsedCertificates?.length) {
    normalizedProfile.certifications = profile.parsedCertificates
  }
}

function applyVisibleTextMappings(profile, rawProfile) {
  // DISABLED: Let AI handle all extraction, don't override with backend parsing
  // The backend parser was interfering with AI results
  
  if (!profile.organization.company_name && profile.experience[0]?.company_name) {
    profile.organization.company_name = profile.experience[0].company_name
  }

  if (!profile.currentCompany && profile.organization.company_name) {
    profile.currentCompany = profile.organization.company_name
  }

  profile.parsedExperience = profile.experience
  profile.parsedEducation = profile.education
  profile.parsedSkills = profile.skills.map((skill) => ({ skill_name: skill }))
  profile.parsedCertificates = profile.certifications || []
  profile.yearsOfExperience = calculateYearsOfExperience(profile.experience, profile.yearsOfExperience)
}

function extractProfileFactsFromText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return {
    experience: parseExperienceSection(getBestSectionLines(lines, "Experience", [
      "Education",
      "Skills",
      "Licenses & certifications",
      "Certifications",
      "Projects",
      "Activity",
      "Featured"
    ], scoreExperienceSection)),
    education: parseEducationSection(getBestSectionLines(lines, "Education", [
      "Skills",
      "Licenses & certifications",
      "Certifications",
      "Projects",
      "Activity",
      "Featured",
      "Experience"
    ], scoreEducationSection)),
    skills: parseSkillsSection(getBestSectionLines(lines, "Skills", [
      "Licenses & certifications",
      "Certifications",
      "Projects",
      "Activity",
      "Featured",
      "Experience",
      "Education"
    ], scoreSkillsSection))
  }
}

function createVisibleMappingText(rawProfile) {
  return [
    rawProfile.visible_text,
    ...(rawProfile.experience_sections || []),
    ...(rawProfile.education_sections || []),
    ...(rawProfile.skills_sections || []),
    ...(rawProfile.languages_sections || [])
  ].filter(Boolean).join("\n")
}

function mergeExperienceItems(primaryItems, fallbackItems) {
  const merged = [...primaryItems]

  for (const fallback of fallbackItems) {
    const existing = merged.find((item) =>
      normalizeKey(item.company_name || item.company) === normalizeKey(fallback.company_name) &&
      normalizeKey(item.position || item.role) === normalizeKey(fallback.position)
    )

    if (existing) {
      existing.company_name = existing.company_name || fallback.company_name
      existing.position = existing.position || fallback.position
      existing.location = existing.location || fallback.location
      existing.service_period = existing.service_period || fallback.service_period
    } else {
      merged.push(fallback)
    }
  }

  return dedupeObjects(merged, experienceKey)
}

function mergeEducationItems(primaryItems, fallbackItems) {
  const merged = [...primaryItems]

  for (const fallback of fallbackItems) {
    const existing = merged.find((item) =>
      normalizeKey(item.institution) === normalizeKey(fallback.institution)
    )

    if (existing) {
      existing.degree = existing.degree || fallback.degree
      existing.field = existing.field || fallback.field
      existing.graduationDate = existing.graduationDate || fallback.graduationDate
    } else {
      merged.push(fallback)
    }
  }

  return dedupeObjects(merged, educationKey)
}

function getBestSectionLines(lines, startLabel, endLabels, scoreSection) {
  const startIndexes = lines
    .map((line, index) => normalizeKey(line) === normalizeKey(startLabel) ? index : -1)
    .filter((index) => index >= 0)

  if (startIndexes.length === 0) {
    return []
  }

  return startIndexes
    .map((startIndex) => getSectionLinesFromIndex(lines, startIndex, endLabels))
    .sort((a, b) => scoreSection(b) - scoreSection(a))[0] || []
}

function getSectionLinesFromIndex(lines, startIndex, endLabels) {
  const endKeys = endLabels.map(normalizeKey)
  const endIndex = lines.findIndex((line, index) =>
    index > startIndex && endKeys.includes(normalizeKey(line))
  )

  return lines
    .slice(startIndex + 1, endIndex === -1 ? lines.length : endIndex)
    .filter(isUsefulProfileLine)
}

function scoreExperienceSection(lines) {
  return lines.filter(isServicePeriod).length * 10 + lines.length
}

function scoreEducationSection(lines) {
  return lines.filter(isEducationPeriod).length * 10 + lines.length
}

function scoreSkillsSection(lines) {
  return parseSkillsSection(lines).length * 10 + lines.length
}

function parseExperienceSection(lines) {
  const experiences = []

  for (let i = 0; i < lines.length; i++) {
    if (!isServicePeriod(lines[i])) {
      continue
    }

    const position = stripProfileAssetSuffix(lines[i - 2] || "")
    const company = cleanCompanyName(lines[i - 1] || "")

    if (!position || !company || isNoiseProfileLine(position) || isNoiseProfileLine(company)) {
      continue
    }

    experiences.push({
      company_name: company,
      position,
      location: "",
      service_period: lines[i]
    })
  }

  return dedupeObjects(experiences, experienceKey)
}

function parseEducationSection(lines) {
  const education = []

  for (let i = 0; i < lines.length; i++) {
    if (!isEducationPeriod(lines[i])) {
      continue
    }

    const degree = stripProfileAssetSuffix(lines[i - 1] || "")
    const institution = stripProfileAssetSuffix(lines[i - 2] || "")

    if (!institution || isNoiseProfileLine(institution)) {
      continue
    }

    education.push({
      institution,
      degree: isNoiseProfileLine(degree) ? "" : degree,
      field: "",
      graduationDate: lines[i]
    })
  }

  return dedupeObjects(education, educationKey)
}

function parseSkillsSection(lines) {
  return uniqueStrings(lines.filter((line) =>
    line.length <= 80 &&
    !isNoiseProfileLine(line) &&
    !/endorsement|endorsed|colleague/i.test(line) &&
    !/^\d+\s+endorsements?$/i.test(line)
  )).slice(0, 50)
}

function isServicePeriod(line) {
  return /\b(?:19|20)\d{2}\b/.test(line) &&
    (/(?:-|\u2013|\u2014)/.test(line) || /\b(?:present|yr|yrs|mo|mos)\b/i.test(line))
}

function isEducationPeriod(line) {
  return /\b(?:19|20)\d{2}\b/.test(line) && /(?:-|\u2013|\u2014)/.test(line)
}

function isUsefulProfileLine(line) {
  return !isNoiseProfileLine(line) && !/\blogo$/i.test(line) && !/^thumbnail\b/i.test(line)
}

function isNoiseProfileLine(line) {
  return /^(follow|message|contact info|show all|view|like|comment|repost|send|more|posts|videos)$/i.test(line) ||
    /^view\s+/i.test(line) ||
    /reactions|comments|reposts|followers/i.test(line)
}

function cleanCompanyName(value) {
  return stripProfileAssetSuffix(String(value || "").split(/\u00b7|\u00c2\u00b7/)[0]).trim()
}

function stripProfileAssetSuffix(value) {
  return String(value || "").replace(/\s+logo$/i, "").trim()
}

function calculateYearsOfExperience(experienceItems, currentValue = 0) {
  const explicitYears = experienceItems
    .map((item) => extractYearsFromPeriod(item.service_period || item.duration || ""))
    .filter((years) => years > 0)

  if (explicitYears.length > 0) {
    return Math.max(...explicitYears)
  }

  return Number(currentValue) || 0
}

function extractYearsFromPeriod(period) {
  const text = String(period || "")
  const explicitYearMatch = text.match(/(\d+(?:\.\d+)?)\s*yrs?/i)

  if (explicitYearMatch) {
    return Number(explicitYearMatch[1])
  }

  const startYearMatch = text.match(/\b((?:19|20)\d{2})\b/)

  if (!startYearMatch || !/present/i.test(text)) {
    return 0
  }

  return Math.max(0, new Date().getFullYear() - Number(startYearMatch[1]))
}

function sanitizeWebsiteUrl(url) {
  if (!url) {
    return ""
  }

  try {
    const host = new URL(url).hostname.replace(/^www\./, "")

    if (isSocialOrNavigationHost(host) || isNavigationUrl(url)) {
      return ""
    }

    return url
  } catch {
    return ""
  }
}

function isHighConfidenceLocalProfile(rawProfile) {
  const confidence = rawProfile.confidence || {}
  const local = rawProfile.local_extraction || {}

  return confidence.level === "high" &&
    confidence.score >= 70 &&
    Boolean(local.full_name) &&
    (local.experience_sections?.length > 0 || local.education_sections?.length > 0 || local.skills?.length > 0)
}

function mapLocalExtraction(rawProfile) {
  const local = rawProfile.local_extraction || {}
  const fullName = cleanName(local.full_name || rawProfile.candidate_name || rawProfile.page_title || "")
  const { firstName, lastName } = splitName(fullName)

  return {
    profile_id: createProfileId(rawProfile.source_url || fullName),
    source_platform: rawProfile.source_platform || "",
    source_url: rawProfile.source_url || "",
    extracted_at: rawProfile.extracted_at || new Date().toISOString(),
    personal_info: {
      first_name: local.first_name || firstName,
      last_name: local.last_name || lastName,
      full_name: fullName,
      headline: local.headline || "",
      job_title: "",
      bio: rawProfile.candidate_description || rawProfile.meta?.description || "",
      location: local.location || "",
      profile_photo_url: local.profile_photo_url || rawProfile.candidate_image || rawProfile.meta?.image || ""
    },
    contact_info: {
      email: local.email || rawProfile.emails?.[0] || "",
      phone: rawProfile.phones?.[0] || "",
      website: local.website || findWebsite(rawProfile.links, rawProfile.source_host),
      linkedin: local.linkedin || findLink(rawProfile.links, "linkedin.com"),
      github: local.github || findLink(rawProfile.links, "github.com"),
      twitter: local.twitter || findLink(rawProfile.links, "twitter.com") || findLink(rawProfile.links, "x.com")
    },
    organization: {
      company_name: "",
      company_website: "",
      industry: "",
      company_size: "",
      company_location: ""
    },
    skills: uniqueStrings(local.skills || []),
    experience: [],
    education: [],
    certifications: [],
    languages: [],
    projects: []
  }
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
    item.company_name || item.company,
    item.position || item.role,
    item.service_period || item.start_date,
    item.end_date
  ].join("|")
}

function educationKey(item) {
  return [
    item.institution,
    item.degree,
    item.field || item.field_of_study,
    item.graduationDate || item.start_year,
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
  return normalizeMappedProfile(mapLocalExtraction(rawProfile), rawProfile)
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
      const normalizedHost = host.replace(/^www\./, "")

      return sourceHost &&
        normalizedHost !== sourceHost &&
        !isSocialOrNavigationHost(normalizedHost) &&
        !isNavigationUrl(link.href)
    } catch {
      return false
    }
  })?.href || ""
}

function isSocialOrNavigationHost(host) {
  return /linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|github\.com/.test(host)
}

function isNavigationUrl(url) {
  return /\/(?:mynetwork|feed|jobs|messaging|notifications|search|premium)(?:\/|$)/i.test(url)
}

const experienceItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["company_name", "position", "location", "service_period"],
  properties: {
    company_name: { type: "string" },
    position: { type: "string" },
    location: { type: "string" },
    service_period: { type: "string" }
  }
}

const educationItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["institution", "degree", "field", "graduationDate"],
  properties: {
    institution: { type: "string" },
    degree: { type: "string" },
    field: { type: "string" },
    graduationDate: { type: "string" }
  }
}

const certificationItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "issuedDate", "expiryDate"],
  properties: {
    name: { type: "string" },
    issuedDate: { type: "string" },
    expiryDate: { type: "string" }
  }
}

const skillItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skill_name"],
  properties: {
    skill_name: { type: "string" }
  }
}

const projectItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["project_name", "description", "project_url"],
  properties: {
    project_name: { type: "string" },
    description: { type: "string" },
    project_url: { type: "string" }
  }
}

const socialMediaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["linkedin", "twitter", "github", "facebook", "instagram"],
  properties: {
    linkedin: { type: "string" },
    twitter: { type: "string" },
    github: { type: "string" },
    facebook: { type: "string" },
    instagram: { type: "string" }
  }
}

const linkItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "text",
    "href"
  ],
  properties: {
    text: { type: "string" },
    href: { type: "string" }
  }
}

const partialProfileSummarySchema = {
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
}

const partialContactInfoSchema = {
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
}

const partialOrganizationSchema = {
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
}

const PARTIAL_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "profile_summary",
    "contact_info",
    "organization",
    "skills",
    "experience",
    "education",
    "certifications",
    "languages",
    "projects",
    "links"
  ],
  properties: {
    profile_summary: partialProfileSummarySchema,
    contact_info: partialContactInfoSchema,
    organization: partialOrganizationSchema,
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
    },
    links: {
      type: "array",
      items: linkItemSchema
    }
  }
}

const PROFILE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "firstName",
    "lastName",
    "linkedInUrl",
    "title",
    "currentPosition",
    "location",
    "currentCompany",
    "bio",
    "profilePhotoUrl",
    "parsedExperience",
    "parsedEducation",
    "university",
    "diploma",
    "graduationDate",
    "parsedSkills",
    "parsedCertificates",
    "languages",
    "email",
    "phone",
    "skype",
    "otherContact",
    "parsedSocialMedia",
    "yearsOfExperience",
    "source",
    "visibility",
    "createdBy",
    "companyId",
    "salary",
    "noticePeriod",
    "nationality",
    "birthdate",
    "gender"
  ],
  properties: {
    firstName: { type: "string" },
    lastName: { type: "string" },
    linkedInUrl: { type: "string" },
    title: { type: "string" },
    currentPosition: { type: "string" },
    location: { type: "string" },
    currentCompany: { type: "string" },
    bio: { type: "string" },
    profilePhotoUrl: { type: "string" },
    parsedExperience: {
      type: "array",
      items: experienceItemSchema
    },
    parsedEducation: {
      type: "array",
      items: educationItemSchema
    },
    university: { type: "string" },
    diploma: { type: "string" },
    graduationDate: { type: "string" },
    parsedSkills: {
      type: "array",
      items: skillItemSchema
    },
    parsedCertificates: {
      type: "array",
      items: certificationItemSchema
    },
    languages: {
      type: "array",
      items: { type: "string" }
    },
    email: { type: "string" },
    phone: { type: "string" },
    skype: { type: "string" },
    otherContact: { type: "string" },
    parsedSocialMedia: socialMediaSchema,
    yearsOfExperience: { type: "number" },
    source: { type: "string" },
    visibility: { type: "string" },
    createdBy: { type: "string" },
    companyId: { type: "string" },
    salary: { type: "string" },
    noticePeriod: { type: "string" },
    nationality: { type: "string" },
    birthdate: { type: "string" },
    gender: { type: "string" }
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

