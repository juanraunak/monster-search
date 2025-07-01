import axios from 'axios';
import * as cheerio from 'cheerio';
import * as readline from 'readline';
import { encode } from 'gpt-tokenizer';
import * as dotenv from 'dotenv';
// Removed youtube-transcript-api import as transcript functionality is now entirely removed.

dotenv.config();

// === Configuration ===
class Settings {
    // API Keys - MOVE TO ENVIRONMENT VARIABLES
    static readonly GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "AIzaSyA4w58rcJiMhxn9CEb0hTTPrU4sJIsZHwE";
    static readonly GOOGLE_CX = process.env.GOOGLE_CX || "b0887ed63455c4c1d";
    static readonly YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || ""; // This is now CRITICAL for YouTube API v3
    static readonly AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
    static readonly AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
    static readonly AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-06-01";
    static readonly AZURE_OPENAI_DEPLOYMENT_ID = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";

    // Multi-Agent Settings
    static readonly MAX_CONCURRENT_REQUESTS = 3;
    static readonly MIN_SUBTOPICS = 1;
    static readonly MAX_SUBTOPICS = 1;
    static readonly COMPLETENESS_THRESHOLD = 0.95;
    static readonly WEBSITES_PER_QUERY = 5;
    static readonly FOUNDATION_QUERIES = 3;

    // Delays
    static readonly DELAY_BETWEEN_SEARCH_QUERIES_MS = 2000;
    static readonly DELAY_AFTER_API_ERROR_MS = 5000;
    static readonly DELAY_BETWEEN_BATCH_FETCHES_MS = 1000;
}

// === Global Variables ===
let total_prompt_tokens = 0;
let total_completion_tokens = 0;


interface YouTubeVideoData {
  title: string;
  url: string;
  videoId: string;
  duration: string;
  views: number;
  channel: string;
  channelUrl: string;
  uploaded: string;
  thumbnail: string;
  snippet: string;
  query: string;
}

// Headers for API calls
const headers = {
    "Content-Type": "application/json",
    "api-key": Settings.AZURE_OPENAI_API_KEY
};

// === Types ===
interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface ExtractedData {
    topic: string;
    intent: string;
}

interface PageSummary {
    url: string;
    content: string;
    tokens: number;
    score: number;
}

interface VideoResult {
    title: string;
    url: string;
    channel: string;
    published: string;
    match: number;
    duration: number;
}

interface FoundationResult {
    summaries: PageSummary[];
    totalPages: number;
    avgScore: number;
}

interface ResourceResult {
    content: string;
    url: string;
    type: 'article' | 'video';
    score: number;
    title?: string;
    channel?: string;
    duration?: number;
}

interface SubtopicWithResource {
    subtopic: string;
    resource: ResourceResult;
    learningObjectives: string[];
    estimatedTime: number;
    difficulty: number;
    prerequisites: string[];
}

interface CourseStructure {
    topic: string;
    intent: string;
    totalUnits: number;
    estimatedHours: number;
    units: SubtopicWithResource[];
    completenessScore: number;
    processingTime: number;
}

// === Utility Functions ===
function count_tokens_from_messages(messages: ChatMessage[], model: string = "gpt-4o"): number {
    const tokens_per_message = 3;
    let num_tokens = 0;
    for (const message of messages) {
        num_tokens += tokens_per_message;
        for (const value of Object.values(message)) {
            num_tokens += encode(String(value)).length;
        }
    }
    num_tokens += 3;
    return num_tokens;
}

async function azure_chat_completion(messages: ChatMessage[]): Promise<string> {
    const url = `${Settings.AZURE_OPENAI_ENDPOINT}/openai/deployments/${Settings.AZURE_OPENAI_DEPLOYMENT_ID}/chat/completions?api-version=${Settings.AZURE_OPENAI_API_VERSION}`;

    const prompt_tokens = count_tokens_from_messages(messages, "gpt-4o");

    try {
        const response = await axios.post(url, {
            messages: messages,
            temperature: 0.7,
            max_tokens: 4000
        }, { headers });

        const content = response.data.choices[0].message.content;
        const completion_tokens = encode(content).length;

        total_prompt_tokens += prompt_tokens;
        total_completion_tokens += completion_tokens;

        console.log(`📏 Tokens - Prompt: ${prompt_tokens} | Completion: ${completion_tokens}`);
        return content;
    } catch (error: any) {
        console.error(`❌ Azure OpenAI API Error: ${error.response?.data || error.message}`);
        throw error;
    }
}

async function executeInParallel<T, R>(
    items: T[],
    asyncFunction: (item: T) => Promise<R>,
    concurrencyLimit: number = Settings.MAX_CONCURRENT_REQUESTS,
    delayBetweenBatches: number = Settings.DELAY_BETWEEN_BATCH_FETCHES_MS
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    while (index < items.length) {
        const batch = items.slice(index, index + concurrencyLimit);
        const batchPromises = batch.map(async (item, i) => {
            try {
                const result = await asyncFunction(item);
                results[index + i] = result;
            } catch (e) {
                console.error(`Error processing item ${index + i}: ${e}`);
                results[index + i] = null as R;
            }
        });
        
        await Promise.all(batchPromises);
        index += concurrencyLimit;

        if (index < items.length) {
            await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
        }
    }

    return results;
}

// === AGENT 1: Intent Extraction Agent ===
import { getSession } from './memory/sessionStore';

export async function runIntentAgent(
  sessionId: string,
  userInput: string
): Promise<{
  reply: string;
  intentExtracted: boolean;
  intent?: ExtractedData;
}> {
  const system_prompt: ChatMessage = {
    role: "system",
    content: `You are an Intent Extraction Agent. Extract learning intent in this format:

{
  "topic": "specific subject to learn",
  "intent": "learning approach and current level"
}

Rules:
- Ask SHORT questions to clarify topic and intent
- "topic" = specific subject (e.g., "piano", "Python programming", "data science")
- "intent" = learning approach + current level (e.g., "complete beginner wanting to build web apps", "intermediate pianist wanting to play jazz")

When both are clear, output JSON and say "Intent extracted. Starting research..."`
  };

  const messages = getSession(sessionId);
  if (messages.length === 0) {
    messages.push(system_prompt);
  }

  messages.push({ role: "user", content: userInput });

  const response = await azure_chat_completion([...messages.slice(-6)]);
  messages.push({ role: "assistant", content: response });

  let extracted: ExtractedData | undefined;
  const intentExtracted = response.includes("Intent extracted");
  if (intentExtracted && response.includes("{")) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.topic && parsed.intent) {
          extracted = { topic: parsed.topic, intent: parsed.intent };
        }
      }
    } catch (e) {
      // continue if JSON parsing fails
    }
  }

  return {
    reply: response,
    intentExtracted,
    intent: extracted,
  };
}

// === AGENT 2: Foundation Builder Agent (Fully Parallel) ===
class SSRFoundationAgent {
    async google_search(query: string): Promise<string[]> {
        console.log(`🔍 Searching: "${query}"`);
        
        const url = `https://www.googleapis.com/customsearch/v1?key=${Settings.GOOGLE_API_KEY}&cx=${Settings.GOOGLE_CX}&q=${encodeURIComponent(query)}`;

        try {
            const response = await axios.get(url, { timeout: 15000 });
            const results = response.data.items || [];
            const urls = results.slice(0, Settings.WEBSITES_PER_QUERY).map((item: any) => item.link);
            console.log(`   Found ${urls.length} URLs`);
            return urls;
        } catch (error: any) {
            console.error(`❌ Search failed for "${query}": ${error.response?.data?.error?.message || error.message}`);
            if (error.response && error.response.status === 429) {
                console.error(`Rate limit hit. Waiting ${Settings.DELAY_AFTER_API_ERROR_MS / 1000} seconds.`);
                await new Promise(resolve => setTimeout(resolve, Settings.DELAY_AFTER_API_ERROR_MS));
            }
            return [];
        }
    }

    async fetch_and_clean_page(url: string): Promise<string | null> {
        try {
            console.log(`🌐 Fetching: ${url}`);
            const response = await axios.get(url, { 
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            
            const $ = cheerio.load(response.data);

            // Remove unwanted elements
            $('script, style, noscript, iframe, header, footer, nav, .ad, .advertisement, .sidebar').remove();

            // Extract main content
            let text = '';
            const contentSelectors = ['main', 'article', '.content', '.post-content', '.entry-content', 'body'];
            
            for (const selector of contentSelectors) {
                const content = $(selector).first();
                if (content.length > 0) {
                    text = content.text();
                    break;
                }
            }
            
            if (!text) {
                text = $('body').text();
            }

            // Clean and normalize text
            text = text
                .replace(/\s+/g, ' ')
                .replace(/[^\w\s.,;:!?()-]/g, '')
                .trim();

            if (text.length < 500) {
                console.log(`   ⚠️ Content too short (${text.length} chars), skipping`);
                return null;
            }

            console.log(`   ✅ Extracted ${text.length} characters`);
            return text.substring(0, 15000);
        } catch (error: any) {
            console.error(`❌ Failed to fetch/clean page ${url}: ${error.message}`);
            return null;
        }
    }

    async summarize_page(content: string, topic: string, intent: string): Promise<string | null> {
        if (!content || content.length < 100) return null;

        const messages: ChatMessage[] = [
            {
                role: "system",
                content: `You are an expert Foundation Builder Agent specialized in extracting educational content.

TASK: Create a focused, educational summary of the provided content that directly supports learning "${topic}" with the intent "${intent}".

SUMMARY REQUIREMENTS:
- Length: 200-300 words
- Focus ONLY on content directly relevant to the learning topic and intent
- Extract: core concepts, fundamental principles, key methods, practical applications, important terminology
- Ignore: marketing content, ads, navigation text, author bios, unrelated topics
- Write in clear, educational language suitable for someone learning this topic
- Structure information logically (concepts → methods → applications)

QUALITY FILTERS:
- If content is mostly marketing/promotional, return "IRRELEVANT_CONTENT"
- If content doesn't relate to the topic, return "OFF_TOPIC"
- If content is too superficial, try to extract what's useful but note limitations

Return ONLY the educational summary or the quality filter response.`
            },
            {
                role: "user",
                content: `Topic: ${topic}
Intent: ${intent}

Content to summarize:
${content.substring(0, 12000)}`
            }
        ];

        try {
            const summary = await azure_chat_completion(messages);
            
            if (summary.includes("IRRELEVANT_CONTENT") || summary.includes("OFF_TOPIC")) {
                console.log(`   ⚠️ Content filtered out as irrelevant`);
                return null;
            }
            
            console.log(`   ✅ Generated summary (${summary.length} chars)`);
            return summary;
        } catch (error) {
            console.error(`❌ Failed to summarize content: ${error}`);
            return null;
        }
    }

    async generate_foundation_queries(topic: string, intent: string): Promise<string[]> {
        const messages: ChatMessage[] = [
            {
                role: "system",
                content: `You are a search query optimization expert for educational content discovery.

TASK: Generate 6-8 strategic Google search queries to build comprehensive foundational knowledge.

QUERY STRATEGY:
1. Target high-quality, text-rich educational content (articles, guides, tutorials, academic resources)
2. Avoid video-heavy platforms (YouTube, TikTok, Instagram)
3. Focus on different aspects:
   - Core concepts and fundamentals
   - Practical methods and techniques
   - Common challenges and solutions
   - Real-world applications
   - Best practices and frameworks
   - Advanced techniques
   - Industry standards

QUERY REQUIREMENTS:
- Length: 3-7 words each
- Specific and targeted
- Use terms that educational sites would likely contain
- Include relevant technical terminology
- Vary the angle of approach

EXAMPLE GOOD QUERIES:
- "machine learning fundamentals tutorial"
- "python data science beginner guide"
- "digital marketing strategy framework"
- "classical piano technique exercises"

Return ONLY the queries, one per line, no numbering or additional text.`
            },
            {
                role: "user",
                content: `Topic: "${topic}"
Learning Intent: "${intent}"`
            }
        ];

        try {
            const response = await azure_chat_completion(messages);
            const queries = response.split('\n')
                .map(q => q.trim())
                .filter(q => q.length > 0 && !q.match(/^\d+\./))
                .slice(0, 8);
            
            console.log(`✅ Generated ${queries.length} foundation queries`);
            return queries;
        } catch (error) {
            console.error(`❌ Failed to generate foundation queries: ${error}`);
            return [
                `${topic} fundamentals guide`,
                `${topic} beginner tutorial`,
                `${topic} best practices`,
                `${topic} advanced techniques`
            ];
        }
    }

    // NEW: Parallel search execution with staggered delays
    async execute_parallel_searches(queries: string[]): Promise<string[]> {
        console.log(`🚀 Executing ${queries.length} searches in parallel with staggered delays...`);
        
        const searchPromises = queries.map(async (query, index) => {
            // Stagger the requests to avoid hitting rate limits
            const delay = index * (Settings.DELAY_BETWEEN_SEARCH_QUERIES_MS / queries.length);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            try {
                return await this.google_search(query);
            } catch (error) {
                console.error(`❌ Search failed for query ${index}: ${query}`);
                return [];
            }
        });

        const allResults = await Promise.all(searchPromises);
        const allUrls = allResults.flat();
        
        // Remove duplicates
        const uniqueUrls = [...new Set(allUrls)];
        console.log(`🔗 Collected ${uniqueUrls.length} unique URLs from ${queries.length} parallel searches`);
        
        return uniqueUrls;
    }

    // NEW: Fully parallel content processing
    async process_urls_in_parallel(
        urls: string[],
        topic: string,
        intent: string
    ): Promise<string[]> {
        console.log(`🔄 Processing ${urls.length} URLs in parallel...`);
        
        const processingPromises = urls.map(async (url) => {
            try {
                // Fetch and clean content
                const content = await this.fetch_and_clean_page(url);
                if (!content) return null;
                
                // Generate summary
                const summary = await this.summarize_page(content, topic, intent);
                return summary;
            } catch (error) {
                console.error(`❌ Failed to process URL: ${url}`);
                return null;
            }
        });

        // Execute all processing in parallel with controlled concurrency
        const results = await executeInParallel(
            processingPromises,
            async (promise) => await promise,
            Settings.MAX_CONCURRENT_REQUESTS,
            Settings.DELAY_BETWEEN_BATCH_FETCHES_MS
        );

        const validSummaries = results.filter((summary): summary is string => !!summary);
        console.log(`✅ Successfully processed ${validSummaries.length}/${urls.length} URLs`);
        
        return validSummaries;
    }

    async build_topic_report(topic: string, intent: string): Promise<string> {
        console.log(`\n${"=".repeat(60)}`);
        console.log(`🕷️ SSR AGENT: BUILDING WEB OF TRUTH (FULLY PARALLEL)`);
        console.log(`${"=".repeat(60)}`);

        const startTime = Date.now();

        // STEP 1: Generate foundation queries
        const queries = await this.generate_foundation_queries(topic, intent);
        if (queries.length === 0) {
            console.error("❌ No foundation queries generated. Cannot build report.");
            return "Unable to generate research queries for this topic.";
        }
        
        console.log(`🔍 Foundation queries:`);
        queries.forEach((q, i) => console.log(`   ${i + 1}. ${q}`));

        // STEP 2: Execute all searches in parallel with staggered timing
        const allUrls = await this.execute_parallel_searches(queries);
        
        if (allUrls.length === 0) {
            console.error("❌ No URLs found from any search queries.");
            return "No foundational content could be discovered for this topic.";
        }

        // STEP 3: Process all URLs in parallel
        const allSummaries = await this.process_urls_in_parallel(allUrls, topic, intent);

        const endTime = Date.now();
        const processingTime = Math.round((endTime - startTime) / 1000);

        console.log(`\n📈 PARALLEL PROCESSING RESULTS:`);
        console.log(`   Total URLs processed: ${allUrls.length}`);
        console.log(`   Successful summaries: ${allSummaries.length}`);
        console.log(`   Success rate: ${Math.round((allSummaries.length / allUrls.length) * 100)}%`);
        console.log(`   Total processing time: ${processingTime} seconds`);

        if (allSummaries.length === 0) {
            console.warn("❌ No summaries were successfully generated from any search queries.");
            return "No foundational content could be gathered for this topic. This might be due to rate limits or the topic being too specialized.";
        }

        // STEP 4: Combine and synthesize all summaries
        const combined = allSummaries.join("\n\n").substring(0, 15000);

        const messages: ChatMessage[] = [
            {
                role: "system",
                content: `You are an expert knowledge synthesizer and educational content architect.

INPUT:
A set of web-derived summaries or extracted content on a single topic, gathered through parallel processing.

GOAL:
Extract and organize only the **teachable knowledge** required to understand and master the topic. Output a structured "Web of Truth" report optimized for generating learning subtopics.

RULES:
- Use ONLY the information provided in the input.
- DO NOT include behavior suggestions (e.g. "take classes", "get inspired").
- DO NOT include tools, apps, or products unless they are core to a learning concept.
- DO NOT include lifestyle, motivation, or emotional benefits unless essential to a concept.
- FOCUS on structuring knowledge into concepts, techniques, relationships, and logical learning order.
- EVERYTHING in the output should be a **teachable unit**, not an action or encouragement.

OUTPUT FORMAT:

# Web of Truth Report: [Topic Name]

## 1. CORE FOUNDATIONS
- Fundamental concepts and principles
- Essential terminology and definitions
- Basic building blocks

✅ High confidence (multiple sources confirm)
⚠️ Medium confidence (limited sources)
❌ Low confidence (single source or unclear)

## 2. KEY METHODOLOGIES
- Primary approaches and techniques
- Standard practices and conceptual frameworks
- Foundational systems (if applicable)

✅ / ⚠️ / ❌

## 3. PRACTICAL APPLICATIONS
- Real-world knowledge applications
- Common domain-specific implementations
- Patterns observed in expert practice

✅ / ⚠️ / ❌

## 4. LEARNING PATHWAYS
- Logical progression of concepts
- Prerequisite relationships
- Skill or concept development sequence

✅ / ⚠️ / ❌

## 5. COMMON CHALLENGES
- Frequent conceptual barriers
- Misconceptions or faulty assumptions
- Conceptual trouble zones and how to approach them

✅ / ⚠️ / ❌

STYLE:
- Use clear, precise, instructional language.
- Structure content hierarchically using lists and sublists.
- No fluff, filler, or motivational commentary.
- All output should support curriculum design and subtopic extraction.`
            },
            {
                role: "user",
                content: `Topic: "${topic}"
Learning Intent: "${intent}"
Number of sources analyzed: ${allSummaries.length}
Processing method: Fully parallel execution

Web-derived summaries:
${combined}`
            }
        ];

        try {
            const finalReport = await azure_chat_completion(messages);
            console.log(`✅ Web of Truth successfully constructed (${finalReport.length} characters)`);
            console.log(`⚡ Total parallel processing completed in ${processingTime} seconds`);
            return finalReport;
        } catch (error) {
            console.error(`❌ Failed to build final topic report: ${error}`);
            return "Failed to synthesize gathered information into a coherent report.";
        }
    }
}
// === SPIDER KING (Advanced Subtopic Analysis) ===
class SpiderKing {
    async identify_subtopics_from_web_of_truth(
        webOfTruth: string,
        topic: string,
        intent: string
    ): Promise<{ title: string; summary: string }[]> {
        console.log(`\n${"=".repeat(60)}`);
        console.log(`🤴 SPIDER KING: ADVANCED SUBTOPIC DECOMPOSITION`);
        console.log(`${"=".repeat(60)}`);

        // STEP 1: Try to process the full Web of Truth first
        console.log(`📏 Web of Truth length: ${webOfTruth.length} characters`);
        
        let subtopics: { title: string; summary: string }[] = [];
        
        // If the Web of Truth is reasonably sized, process it as a whole
        if (webOfTruth.length <= 12000) {
            console.log(`🔍 Processing Web of Truth as single unit...`);
            subtopics = await this.run_spider_pass(webOfTruth, topic, intent, "COMPLETE");
        } else {
            // STEP 2: Split the Web of Truth into manageable parts
            console.log(`🔪 Web of Truth too large, splitting into parts...`);
            const [partA, partB] = this.splitWebOfTruth(webOfTruth);
            
            console.log(`   Part A: ${partA.length} characters`);
            console.log(`   Part B: ${partB.length} characters`);

            // STEP 3: Generate subtopics from both parts
            const subtopicsA = await this.run_spider_pass(partA, topic, intent, "PART A");
            const subtopicsB = await this.run_spider_pass(partB, topic, intent, "PART B");

            // STEP 4: Combine and deduplicate
            subtopics = this.combineAndDeduplicate([...subtopicsA, ...subtopicsB]);
        }

        console.log(`\n🧵 FINAL RESULT: ${subtopics.length} subtopics extracted`);
        subtopics.forEach((s, i) => console.log(`   ${i + 1}. ${s.title}`));

        if (subtopics.length < 8) {
            console.warn(`⚠️ Only ${subtopics.length} subtopics extracted. This might indicate parsing issues.`);
            console.warn(`   Consider checking the Web of Truth format or adjusting the extraction logic.`);
        }

        return subtopics;
    }

    private splitWebOfTruth(web: string): [string, string] {
        // Try multiple split strategies
        const splitPoints = [
            "## 3. PRACTICAL APPLICATIONS",
            "### 3. PRACTICAL APPLICATIONS", 
            "# 3. PRACTICAL APPLICATIONS",
            "3. PRACTICAL APPLICATIONS",
            "## PRACTICAL APPLICATIONS",
            "PRACTICAL APPLICATIONS"
        ];

        for (const splitPoint of splitPoints) {
            const index = web.indexOf(splitPoint);
            if (index > 0 && index < web.length * 0.8) { // Ensure reasonable split
                console.log(`✂️ Splitting at: "${splitPoint}"`);
                return [web.slice(0, index).trim(), web.slice(index).trim()];
            }
        }

        // Fallback: intelligent content-aware split
        console.warn("⚠️ No natural split point found, using intelligent split.");
        return this.intelligentSplit(web);
    }

    private intelligentSplit(web: string): [string, string] {
        const lines = web.split('\n');
        const midPoint = Math.floor(lines.length / 2);
        
        // Look for a good break point near the middle (header or section break)
        for (let i = midPoint - 10; i <= midPoint + 10; i++) {
            if (i >= 0 && i < lines.length) {
                const line = lines[i].trim();
                if (line.startsWith('#') || line.startsWith('##') || line.length === 0) {
                    const partA = lines.slice(0, i).join('\n').trim();
                    const partB = lines.slice(i).join('\n').trim();
                    console.log(`✂️ Intelligent split at line ${i}: "${line.substring(0, 50)}..."`);
                    return [partA, partB];
                }
            }
        }

        // Ultimate fallback: split by character count
        const mid = Math.floor(web.length / 2);
        return [web.slice(0, mid), web.slice(mid)];
    }

    private combineAndDeduplicate(subtopics: { title: string; summary: string }[]): { title: string; summary: string }[] {
        const seen = new Set<string>();
        const unique: { title: string; summary: string }[] = [];

        for (const subtopic of subtopics) {
            const normalizedTitle = subtopic.title.toLowerCase().trim();
            if (!seen.has(normalizedTitle) && subtopic.title.length > 5) {
                seen.add(normalizedTitle);
                unique.push(subtopic);
            }
        }

        console.log(`🔄 Deduplicated ${subtopics.length} → ${unique.length} subtopics`);
        return unique;
    }

    private async run_spider_pass(
        webSection: string,
        topic: string,
        intent: string,
        label: string
    ): Promise<{ title: string; summary: string }[]> {
        console.log(`\n🔍 Running Spider King on ${label}...`);
        console.log(`   Input length: ${webSection.length} characters`);

        const messages: ChatMessage[] = [
            {
                role: "system",
                content: `You are the SPIDER KING — an elite AI architect specializing in learning curriculum design.

**MISSION**: Analyze the provided "Web of Truth" report and extract 8-15 distinct, learnable subtopics that form a complete educational journey.

**SUBTOPIC EXTRACTION RULES**:
1. **DISTINCT**: Each subtopic must cover a unique aspect - no overlapping content
2. **PROGRESSIVE**: Order from foundational concepts to advanced applications  
3. **COMPREHENSIVE**: Together they must cover the complete topic scope
4. **LEARNER-FOCUSED**: Everything must directly serve the stated learning intent
5. **ACTIONABLE**: Each subtopic should represent a concrete learning milestone

**REQUIRED OUTPUT FORMAT** (CRITICAL - Follow exactly):

SUBTOPIC_START
Title: [Clear, descriptive subtopic name]
Summary: [Comprehensive 200-300 word explanation covering: 
- What this subtopic teaches
- Why it's important for mastering the main topic
- How it fits in the learning progression
- Key concepts and skills gained
- Any prerequisites or connections to other subtopics
- Practical applications or outcomes]
SUBTOPIC_END

SUBTOPIC_START
Title: [Next subtopic name]
Summary: [Next comprehensive summary]
SUBTOPIC_END


**CRITICAL REQUIREMENTS**:
- Use EXACTLY the format above with SUBTOPIC_START and SUBTOPIC_END markers
- Generate 8-15 subtopics minimum
- Each summary must be 200-300 words
- Maintain logical learning progression
- Extract content ONLY from the provided Web of Truth
- No marketing fluff or motivational content - pure educational value

**EXTRACTION STRATEGY**:
- Identify core concepts, methodologies, applications, and advanced techniques
- Look for natural learning boundaries and skill-building opportunities
- Consider prerequisite relationships and concept dependencies
- Focus on teachable, measurable learning outcomes`
            },
            {
                role: "user",
                content: `**LEARNING CONTEXT**:
Topic: "${topic}"
Learning Intent: "${intent}"

**WEB OF TRUTH REPORT TO ANALYZE**:
${webSection}

Please extract comprehensive learning subtopics using the exact format specified above. Focus on creating a complete learning journey that progresses logically from basics to mastery.`
            }
        ];

        try {
            const response = await azure_chat_completion(messages);
            console.log(`📝 Spider King response length: ${response.length} characters`);
            
            // Enhanced parsing with better error handling
            const subtopics = this.parseSubtopicsFromResponse(response);
            
            console.log(`✅ ${label} extracted ${subtopics.length} subtopics`);
            
            if (subtopics.length === 0) {
                console.error(`❌ Failed to parse any subtopics from ${label} response`);
                console.error(`Response preview: ${response.substring(0, 500)}...`);
            }
            
            return subtopics;
        } catch (error) {
            console.error(`❌ ${label} failed: ${error}`);
            return [];
        }
    }

    private parseSubtopicsFromResponse(response: string): { title: string; summary: string }[] {
        const subtopics: { title: string; summary: string }[] = [];
        
        // Method 1: Try the structured format with markers
        const markerPattern = /SUBTOPIC_START\s*\n?Title:\s*(.+?)\s*\n?Summary:\s*([\s\S]*?)\s*SUBTOPIC_END/gi;
        let match;
        
        while ((match = markerPattern.exec(response)) !== null) {
            const title = match[1].trim();
            const summary = match[2].trim();
            
            if (title && summary && summary.length > 50) {
                subtopics.push({ title, summary });
            }
        }
        
        if (subtopics.length > 0) {
            console.log(`✅ Parsed ${subtopics.length} subtopics using structured format`);
            return subtopics;
        }
        
        // Method 2: Fallback - look for Title/Summary patterns
        console.log(`⚠️ Structured format failed, trying fallback parsing...`);
        const fallbackPattern = /(?:^|\n)(?:Title|Subtopic):\s*(.+?)\s*\n(?:Summary):\s*([\s\S]*?)(?=\n(?:Title|Subtopic):|$)/gi;
        
        while ((match = fallbackPattern.exec(response)) !== null) {
            const title = match[1].trim();
            const summary = match[2].trim();
            
            if (title && summary && summary.length > 50) {
                subtopics.push({ title, summary });
            }
        }
        
        if (subtopics.length > 0) {
            console.log(`✅ Parsed ${subtopics.length} subtopics using fallback method`);
            return subtopics;
        }
        
        // Method 3: Last resort - split by sections and try to extract
        console.log(`⚠️ All parsing methods failed, attempting manual extraction...`);
        return this.manualExtractionFallback(response);
    }
    
    private manualExtractionFallback(response: string): { title: string; summary: string }[] {
        const subtopics: { title: string; summary: string }[] = [];
        
        // Split by likely section breaks
        const sections = response.split(/\n\s*\n|\n(?=\d+\.|\*|#)/);
        
        for (const section of sections) {
            const lines = section.trim().split('\n');
            if (lines.length < 2) continue;
            
            const firstLine = lines[0].trim();
            const restOfSection = lines.slice(1).join('\n').trim();
            
            // Look for title-like patterns
            if (firstLine.length > 10 && firstLine.length < 100 && restOfSection.length > 100) {
                // Clean up the title
                const title = firstLine
                    .replace(/^\d+\.\s*/, '')
                    .replace(/^[-*]\s*/, '')
                    .replace(/^#+\s*/, '')
                    .replace(/Title:\s*/i, '')
                    .replace(/Subtopic:\s*/i, '')
                    .trim();
                
                const summary = restOfSection
                    .replace(/^Summary:\s*/i, '')
                    .trim();
                
                if (title && summary && summary.length > 50) {
                    subtopics.push({ title, summary });
                }
            }
        }
        
        console.log(`📋 Manual extraction found ${subtopics.length} potential subtopics`);
        return subtopics;
    }
}

// === INFO SPIDER AGENT (Deep Subtopic Investigation) ===
class InfoSpiderAgent {
    async investigate_subtopic(
        subtopic: string,
        topic: string,
        intent: string
    ): Promise<{ report: string; summary: string; subtopic: string }> {
        console.log(`\n🕷️ INFO SPIDER investigating: "${subtopic}"`);

        // Generate targeted search queries
        const queryPrompt: ChatMessage[] = [
            {
                role: "system",
                content: `Generate 3 highly targeted Google search queries to deeply investigate this subtopic.

QUERY STRATEGY:
- Query 1: Focus on fundamentals and core concepts
- Query 2: Target practical examples and tutorials  
- Query 3: Look for advanced techniques and best practices

REQUIREMENTS:
- 4-8 words per query
- Use specific technical terminology
- Target educational content (tutorials, guides, documentation)
- Avoid video platforms

Return only the queries, one per line.`
            },
            {
                role: "user",
                content: `Subtopic: ${subtopic}
Main Topic: ${topic}
Learning Intent: ${intent}`
            }
        ];

        try {
            const queryResponse = await azure_chat_completion(queryPrompt);
            const queries = queryResponse.split("\n").map(q => q.trim()).filter(Boolean).slice(0, 3);
            
            console.log(`🔍 Search queries: ${queries.join(" | ")}`);

            // Collect URLs from all queries
            const ssrAgent = new SSRFoundationAgent();
            const allUrls: string[] = [];
            
            for (const query of queries) {
                const urls = await ssrAgent.google_search(query);
                allUrls.push(...urls);
            }

            // Remove duplicates
            const uniqueUrls = [...new Set(allUrls)];
            console.log(`🔗 Found ${uniqueUrls.length} unique URLs to investigate`);

            // Scrape and process content
            const scrapedContents = await executeInParallel(
                uniqueUrls,
                async (url) => {
                    const content = await ssrAgent.fetch_and_clean_page(url);
                    return { url, content };
                },
                Settings.MAX_CONCURRENT_REQUESTS,
                Settings.DELAY_BETWEEN_BATCH_FETCHES_MS
            );

            // Filter and combine valid content
            const validContents = scrapedContents
                .filter(item => item && item.content && item.content.length > 200)
                .map(item => `Source: ${item.url}\n${item.content}`)
                .join("\n\n");

            if (!validContents) {
                console.log(`⚠️ No valid content found for subtopic: ${subtopic}`);
                return {
                    subtopic,
                    report: `Unable to gather sufficient information about ${subtopic}. This may be a highly specialized or emerging topic.`,
                    summary: `No information available for ${subtopic}`
                };
            }

            // Generate comprehensive report
            const reportPrompt: ChatMessage[] = [
                {
                    role: "system",
                    content: `You are an expert educational content synthesizer.

TASK: Create a clear and focused educational report for the given subtopic using ONLY the provided web content.

Your report should help learners quickly understand what the subtopic is, why it matters, and what it teaches — without going into unnecessary detail.

STRUCTURE:
1. SUBTOPIC OVERVIEW (2–3 sentences)
   - Briefly define the subtopic and its scope
   - Explain how it supports the main topic and learning goal

2. CORE INSIGHTS
   - Summarize the essential concepts or principles taught
   - Highlight what the learner should understand or be able to do after reading this

3. PRACTICAL VALUE
   - Show how this subtopic is used in real learning or life situations
   - Include relevant examples or simple applications if available

REQUIREMENTS:
- Use only the web content provided
- Avoid fluff, repetition, or academic over-explaining
- Write in clear, educational language
- Focus on what matters most for the learner's intent
- Target length: 300–500 words max`
                },
                {
                    role: "user",
                    content: `Subtopic: ${subtopic}
Main Topic: ${topic}
Learning Intent: ${intent}

Web Content:
${validContents.substring(0, 12000)}`
                }
            ];

            // Generate summary for YouTube search
            const summaryPrompt: ChatMessage[] = [
                {
                    role: "system",
                    content: `Create a concise summary that captures the key concepts and terms for this subtopic.

REQUIREMENTS:
- 50-80 words maximum
- Include the most important technical terms and concepts
- Focus on searchable keywords that would help find relevant YouTube videos
- Avoid fluff words, keep it dense with meaningful content
- Write as a single paragraph

This summary will be used to generate YouTube search queries, so include terms that would appear in video titles and descriptions.`
                },
                {
                    role: "user",
                    content: `Subtopic: ${subtopic}
Main Topic: ${topic}
Learning Intent: ${intent}

Web Content:
${validContents.substring(0, 8000)}`
                }
            ];

            const [report, summary] = await Promise.all([
                azure_chat_completion(reportPrompt),
                azure_chat_completion(summaryPrompt)
            ]);

            console.log(`✅ Generated comprehensive report and summary for: ${subtopic}`);
            
            return {
                subtopic,
                report,
                summary
            };

        } catch (error) {
            console.error(`❌ Failed to investigate subtopic "${subtopic}": ${error}`);
            return {
                subtopic,
                report: `Investigation failed for ${subtopic}. Unable to gather sufficient information due to technical limitations.`,
                summary: `Failed to generate summary for ${subtopic}`
            };
        }
    }

    async investigate_all_subtopics(
        subtopics: { title: string; summary: string }[],
        topic: string,
        intent: string
    ): Promise<{ subtopic: string; report: string; summary: string }[]> {
        console.log(`\n${"=".repeat(60)}`);
        console.log(`🕷️ INFO SPIDER AGENT: DEEP SUBTOPIC INVESTIGATION`);
        console.log(`${"=".repeat(60)}`);
        console.log(`🎯 Investigating ${subtopics.length} subtopics with ${Settings.MAX_CONCURRENT_REQUESTS} concurrent threads`);

        const results = await executeInParallel(
            subtopics,
            async (subtopic) => await this.investigate_subtopic(subtopic.title, topic, intent),
            Settings.MAX_CONCURRENT_REQUESTS,
            Settings.DELAY_BETWEEN_BATCH_FETCHES_MS
        );

        const validResults = results.filter(r => r !== null);
        console.log(`\n📊 Investigation Complete:`);
        console.log(`   Subtopics processed: ${subtopics.length}`);
        console.log(`   Successful investigations: ${validResults.length}`);
        console.log(`   Success rate: ${Math.round((validResults.length / subtopics.length) * 100)}%`);

        return validResults;
    }
}



interface YouTubeVideoData {
  title: string;
  url: string;
  videoId: string;
  duration: string;
  views: number;
  channel: string;
  channelUrl: string;
  uploaded: string;
  thumbnail: string;
  snippet: string;
  query: string;
  source?: 'google' | 'youtube'; // Added source tracking
}

class YouTubeSpiderAgent {

  // NEW: Google scraping function for YouTube results
  async scrapeGoogleYouTubeResults(query: string): Promise<YouTubeVideoData[]> {
    console.log(`🔍 Scraping Google for YouTube results: "${query}"`);
    
    const searchUrl = `https://www.google.com/search?q=site:youtube.com+${encodeURIComponent(query)}`;
    const videos: YouTubeVideoData[] = [];

    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      };

      const response = await axios.get(searchUrl, { headers, timeout: 15000 });
      const $ = cheerio.load(response.data);

      // Find YouTube video links in Google search results
      $('a[href*="youtube.com/watch"]').each((index, element) => {
        if (videos.length >= 10) return false; // Limit to top 10 results

        const $link = $(element);
        const href = $link.attr('href');
        
        if (!href) return;

        // Extract clean YouTube URL
        let videoUrl = '';
        let videoId = '';
        
        if (href.startsWith('/url?q=')) {
          // Google redirected URL
          const urlMatch = href.match(/\/url\?q=([^&]+)/);
          if (urlMatch) {
            videoUrl = decodeURIComponent(urlMatch[1]);
          }
        } else if (href.includes('youtube.com/watch')) {
          videoUrl = href;
        }

        if (!videoUrl) return;

        // Extract video ID
        const videoIdMatch = videoUrl.match(/[?&]v=([^&]+)/);
        if (!videoIdMatch) return;
        
        videoId = videoIdMatch[1];

        // Find the parent result container to extract title and snippet
        const $result = $link.closest('div[data-ved]').length ? $link.closest('div[data-ved]') : $link.closest('.g');
        
        // Extract title - try multiple selectors
        let title = '';
        const $titleElement = $result.find('h3').first();
        if ($titleElement.length) {
          title = $titleElement.text().trim();
        } else {
          // Fallback: try to get from link text
          title = $link.text().trim() || `Video ${videoId}`;
        }

        // Extract snippet/description
        let snippet = '';
        const $snippetElement = $result.find('[data-snf]').first();
        if ($snippetElement.length) {
          snippet = $snippetElement.text().trim();
        } else {
          // Fallback: look for description text
          const $descElement = $result.find('span').filter((i, el) => {
            const text = $(el).text();
            return text.length > 50 && !text.includes('›') && !text.includes('•');
          }).first();
          snippet = $descElement.text().trim();
        }

        // Try to extract channel name from URL or snippet
        let channel = '';
        const channelMatch = snippet.match(/([^•]+)(?:\s*•|\s*-|\s*\|)/);
        if (channelMatch) {
          channel = channelMatch[1].trim();
        } else {
          // Fallback: extract from URL if possible
          const urlParts = videoUrl.split('/');
          const channelIndex = urlParts.indexOf('channel') + 1;
          if (channelIndex > 0 && channelIndex < urlParts.length) {
            channel = urlParts[channelIndex];
          } else {
            channel = 'Unknown Channel';
          }
        }

        // Clean up title and snippet
        title = title.replace(/^\s*-\s*YouTube\s*$/, '').trim();
        if (!title || title === 'YouTube') {
          title = snippet.split('.')[0] || `Video ${videoId}`;
        }

        const video: YouTubeVideoData = {
          title: title || `YouTube Video ${videoId}`,
          url: videoUrl,
          videoId: videoId,
          duration: 'N/A', // Google doesn't provide duration
          views: 0, // Google doesn't provide view count
          channel: channel,
          channelUrl: `https://www.youtube.com/channel/${channel}`,
          uploaded: '', // Google doesn't provide upload date
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          snippet: snippet || '',
          query: query,
          source: 'google'
        };

        videos.push(video);
      });

      console.log(`✅ Google scraping complete: Found ${videos.length} YouTube videos`);
      return videos;

    } catch (error: any) {
      console.error(`❌ Google scraping failed for "${query}":`, error.message);
      return [];
    }
  }

  // Updated to generate search queries from summary instead of full report
  async generate_search_queries_from_summary(topic: string, subtopic: string, summary: string): Promise<string[]> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are a Youtube query generator. Generate 8-10 diverse and highly relevant Youtube queries based on the provided summary.

REQUIREMENTS:
- Extract key technical terms and concepts from the summary
- Create queries that would find educational videos specifically about these concepts
- Include variations like tutorials, explanations, guides, examples
- Focus on content longer than YouTube Shorts (avoid short-form content terms)
- 3-6 words per query for best Youtube results
- Focus on terms that would appear in video titles

Output only a JSON array of strings, no other text.`
      },
      {
        role: 'user',
        content: `Topic: ${topic}
Subtopic: ${subtopic}

Summary: ${summary}

Generate 8-10 Youtube queries based on the key concepts in this summary.`
      }
    ];

    try {
      const response = await azure_chat_completion(messages);
      let queries: string[] = [];
      try {
        const match = response.match(/\[[\s\S]*\]/);
        if (match) {
          queries = JSON.parse(match[0]);
        }
      } catch (e) {
        console.error("❌ Failed to parse queries from GPT:", e);
      }

      return queries.length > 0 ? queries : [
        `${subtopic} tutorial`,
        `${subtopic} explained`,
        `${topic} ${subtopic} guide`,
        `how to ${subtopic}`,
        `${subtopic} examples`,
        `${topic} ${subtopic} course`,
        `${subtopic} complete`,
        `${subtopic} walkthrough`,
        `${topic} ${subtopic} fundamentals`,
        `${subtopic} comprehensive`
      ];
    } catch (e) {
      console.error(`❌ Query generation failed: ${e}`);
      return [
        `${subtopic} tutorial`,
        `${subtopic} explained`,
        `${topic} ${subtopic} guide`,
        `how to ${subtopic}`,
        `${subtopic} examples`,
        `${topic} ${subtopic} course`,
        `${subtopic} complete`,
        `${subtopic} walkthrough`,
        `${topic} ${subtopic} fundamentals`,
        `${subtopic} comprehensive`
      ];
    }
  }

  // YouTube scraper with shorts filtering during search
  async scrape_Youtube(query: string, maxPages: number = 5): Promise<YouTubeVideoData[]> {
    console.log(`🕷️ Scraping Youtube: "${query}" (${maxPages} pages)`);

    const allVideos: YouTubeVideoData[] = [];
    const baseUrl = 'https://www.youtube.com/results';
    const videosPerPage = 20; // Approximate videos per page

    try {
      for (let page = 0; page < maxPages; page++) {
        console.log(`📄 Scraping page ${page + 1}/${maxPages} for: "${query}"`);

        let searchUrl = `${baseUrl}?search_query=${encodeURIComponent(query)}`;

        // REMOVED: Specific duration filter like '>20min'.
        // We will now rely on the internal filtering for shorts (<= 1 min).
        // If you specifically wanted "4-20 min" you'd use '&sp=EgIYBA%253D%253D' here.
        // But for "longer than 1 minute" (non-shorts), removing the sp parameter
        // and relying on the internal filter is most robust.

        const response = await this.makeHttpRequest(searchUrl);
        if (!response) {
          console.warn(`⚠️ Failed to fetch page ${page + 1} for query: "${query}"`);
          continue;
        }

        const pageVideos = this.parseYouTubeSearchResults(response, query);

        // Filter out shorts immediately during parsing: NOW Filters anything <= 1 minute
        const filteredVideos = pageVideos.filter(video => {
          const durationMinutes = this.parseDurationToMinutes(video.duration);
          if (durationMinutes <= 1 && durationMinutes > 0) { // Keep filtering <= 1 min
            console.log(`🚫 Filtered Short during scrape: ${video.title.substring(0, 30)}... (${video.duration})`);
            return false;
          }
          return true;
        });

        // Mark as YouTube source
        filteredVideos.forEach(video => video.source = 'youtube');

        allVideos.push(...filteredVideos);
        console.log(`✅ Page ${page + 1}: Found ${pageVideos.length} videos, ${filteredVideos.length} after filtering shorts (Total: ${allVideos.length})`);

        // Stop if we have enough videos
        if (allVideos.length >= 50) {
          console.log(`🎯 Reached target of 50+ videos (${allVideos.length}), stopping scrape`);
          break;
        }

        // Add delay between pages to avoid rate limiting
        if (page < maxPages - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
        }
      }

      // Remove duplicates
      const uniqueVideos = allVideos.filter((video, index, self) =>
        index === self.findIndex(v => v.videoId === video.videoId && v.videoId)
      );

      console.log(`🕷️ Scraping complete: ${uniqueVideos.length} unique videos (${allVideos.length - uniqueVideos.length} duplicates removed)`);
      return uniqueVideos;

    } catch (error: any) {
      console.error(`❌ YouTube scraping failed for "${query}":`, error.message);
      return allVideos;
    }
  }

  // Make HTTP request with proper headers
  private async makeHttpRequest(url: string): Promise<string | null> {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      };

      const response = await axios.get(url, { headers, timeout: 15000 });
      return response.data;
    } catch (error: any) {
      console.error(`❌ HTTP request failed for ${url}:`, error.message);
      return null;
    }
  }

  // Parse Youtube results from HTML
  private parseYouTubeSearchResults(html: string, query: string): YouTubeVideoData[] {
    const videos: YouTubeVideoData[] = [];

    try {
      // Extract JSON data from YouTube's initial data
      const scriptRegex = /var ytInitialData = ({.*?});/;
      const match = html.match(scriptRegex);

      if (!match) {
        console.warn('⚠️ Could not find ytInitialData in HTML');
        return this.parseYouTubeResultsFallback(html, query);
      }

      const ytData = JSON.parse(match[1]);
      const contents = ytData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;

      if (!contents) {
        console.warn('⚠️ Could not find search results in ytInitialData');
        return this.parseYouTubeResultsFallback(html, query);
      }

      // Find video results
      for (const section of contents) {
        const items = section?.itemSectionRenderer?.contents || [];

        for (const item of items) {
          const videoRenderer = item?.videoRenderer;
          if (!videoRenderer) continue;

          const videoId = videoRenderer.videoId;
          const title = videoRenderer.title?.runs?.[0]?.text || videoRenderer.title?.simpleText || '';
          const channel = videoRenderer.ownerText?.runs?.[0]?.text || '';
          const viewsText = videoRenderer.viewCountText?.simpleText || videoRenderer.viewCountText?.runs?.[0]?.text || '0';
          const durationText = videoRenderer.lengthText?.simpleText || '';
          const thumbnailUrl = videoRenderer.thumbnail?.thumbnails?.[0]?.url || '';
          const description = videoRenderer.descriptionSnippet?.runs?.map((r: any) => r.text).join('') || '';
          const publishedTime = videoRenderer.publishedTimeText?.simpleText || '';

          if (videoId && title) {
            const video: YouTubeVideoData = {
              title: title,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              videoId: videoId,
              duration: durationText || 'N/A',
              views: this.parseViews(viewsText),
              channel: channel,
              channelUrl: `https://www.youtube.com/channel/${videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ''}`,
              uploaded: publishedTime,
              thumbnail: thumbnailUrl,
              snippet: description,
              query: query,
              source: 'youtube'
            };

            videos.push(video);
          }
        }
      }

    } catch (error: any) {
      console.error('❌ Error parsing Youtube results:', error.message);
      return this.parseYouTubeResultsFallback(html, query);
    }

    return videos;
  }

  // Fallback parser using regex patterns
  private parseYouTubeResultsFallback(html: string, query: string): YouTubeVideoData[] {
    const videos: YouTubeVideoData[] = [];

    try {
      // Regex patterns for extracting video data
      const videoRegex = /"videoId":"([^"]+)".*?"title":{"runs":\[{"text":"([^"]+)"}.*?"ownerText":{"runs":\[{"text":"([^"]+)"}.*?"viewCountText":{"simpleText":"([^"]+)"}.*?"lengthText":{"simpleText":"([^"]+)"}/g;

      let match;
      while ((match = videoRegex.exec(html)) !== null && videos.length < 20) {
        const [, videoId, title, channel, viewsText, duration] = match;

        const video: YouTubeVideoData = {
          title: title.replace(/\\u0026/g, '&').replace(/\\"/g, '"'),
          url: `https://www.youtube.com/watch?v=${videoId}`,
          videoId: videoId,
          duration: duration,
          views: this.parseViews(viewsText),
          channel: channel.replace(/\\u0026/g, '&').replace(/\\"/g, '"'),
          channelUrl: '',
          uploaded: '',
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          snippet: '',
          query: query,
          source: 'youtube'
        };

        videos.push(video);
      }

    } catch (error: any) {
      console.error('❌ Fallback parsing failed:', error.message);
    }

    return videos;
  }

  // Parse duration to minutes for filtering
  private parseDurationToMinutes(duration: string): number {
    if (!duration || duration === 'N/A') return 0;

    // Handle different duration formats
    const timeMatch = duration.match(/(\d+):(\d+)(?::(\d+))?/);
    if (timeMatch) {
      const [, first, second, third] = timeMatch;
      if (third) {
        // HH:MM:SS format
        return parseInt(first) * 60 + parseInt(second) + parseInt(third) / 60;
      } else {
        // MM:SS format
        return parseInt(first) + parseInt(second) / 60;
      }
    }

    return 0;
  }

  // MODIFIED: Enhanced multi-query scraping with hybrid approach
  async search_youtube_videos_parallel(topic: string, subtopic: string, summary: string): Promise<YouTubeVideoData[]> {
    console.log(`🚀 Starting hybrid YouTube scraping for: ${topic} - ${subtopic}`);
    console.log(`📝 Using summary: ${summary.substring(0, 100)}...`);

    const queries = await this.generate_search_queries_from_summary(topic, subtopic, summary);
    console.log(`📝 Generated ${queries.length} search queries from summary`);

    const allVideos: YouTubeVideoData[] = [];
    const targetTotal = 50;
    const minGoogleResults = 5;

    // Process queries sequentially to avoid overwhelming the server
    for (let i = 0; i < queries.length && allVideos.length < targetTotal; i++) {
      const query = queries[i];
      console.log(`🔍 [${i + 1}/${queries.length}] Hybrid scraping: "${query}"`);

      // Step 1: Try Google search first
      console.log(`   🔍 Trying Google search...`);
      const googleVideos = await this.scrapeGoogleYouTubeResults(query);
      
      let queryVideos: YouTubeVideoData[] = [];
      
      if (googleVideos.length >= minGoogleResults) {
        console.log(`   ✅ Google found ${googleVideos.length} results - using Google results`);
        queryVideos = googleVideos;
      } else {
        console.log(`   ⚠️ Google found only ${googleVideos.length} results - falling back to YouTube scraping`);
        
        // Step 2: Fall back to YouTube scraping
        const videosPerQuery = Math.ceil((targetTotal - allVideos.length) / (queries.length - i));
        const pagesNeeded = Math.ceil(videosPerQuery / 15); // ~15 videos per page
        const youtubeVideos = await this.scrape_Youtube(query, Math.min(pagesNeeded, 3));
        
        // Combine Google and YouTube results, prioritizing Google
        queryVideos = [...googleVideos, ...youtubeVideos];
        console.log(`   📊 Combined results: ${googleVideos.length} from Google + ${youtubeVideos.length} from YouTube = ${queryVideos.length} total`);
      }

      // Deduplicate within this query's results
      const uniqueQueryVideos = queryVideos.filter((video, index, self) =>
        index === self.findIndex(v => v.videoId === video.videoId && v.videoId)
      );

      allVideos.push(...uniqueQueryVideos);
      console.log(`📊 Query ${i + 1} complete: +${uniqueQueryVideos.length} unique videos (Total: ${allVideos.length})`);

      // Add delay between queries
      if (i < queries.length - 1 && allVideos.length < targetTotal) {
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
      }
    }

    // Final deduplication across all queries
    const uniqueVideos = allVideos.filter((video, index, self) =>
      index === self.findIndex(v => v.videoId === video.videoId && v.videoId)
    );

    // Sort by views for initial quality filter
    const sortedVideos = uniqueVideos.sort((a, b) => b.views - a.views);

    console.log(`🎯 Hybrid scraping complete: Found ${uniqueVideos.length} unique videos (filtered ${allVideos.length - uniqueVideos.length} duplicates)`);
    
    // Log source distribution
    const googleCount = sortedVideos.filter(v => v.source === 'google').length;
    const youtubeCount = sortedVideos.filter(v => v.source === 'youtube').length;
    console.log(`📊 Source distribution: ${googleCount} from Google, ${youtubeCount} from YouTube`);
    
    console.log(`📋 Duration distribution:`);

    // Log duration stats (only for videos with duration info)
    const durations = sortedVideos.map(v => this.parseDurationToMinutes(v.duration)).filter(d => d > 0);
    if (durations.length > 0) {
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const longForm = durations.filter(d => d >= 10).length;
      console.log(`   Average: ${avgDuration.toFixed(1)} min, Long-form (10+ min): ${longForm}/${durations.length}`);
    } else {
      console.log(`   No duration data available (Google results don't include duration)`);
    }

    return sortedVideos;
  }

  // Legacy method for backward compatibility - now uses scraping
  async search_youtube_direct(query: string, limit: number = 15): Promise<YouTubeVideoData[]> {
    const pages = Math.ceil(limit / 15);
    const results = await this.scrape_Youtube(query, pages);
    return results.slice(0, limit);
  }

  // Updated to use scraping instead of API
  async investigate_subtopic_video(subtopic: string, topic: string, intent: string, summary: string): Promise<any | null> {
    console.log(`🎯 Finding best YouTube video for: ${subtopic} (via hybrid scraping)`);

    const allVideos = await this.search_youtube_videos_parallel(topic, subtopic, summary);

    if (allVideos.length === 0) {
      console.warn(`⚠️ No YouTube videos found for ${subtopic}`);
      return null;
    }

    const best = await this.select_best_video(allVideos, subtopic, topic, intent, summary);
    return best;
  }

  // Helper methods remain the same
  extractVideoId(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.searchParams.get("v") || url.split('v=')[1]?.split('&')[0] || '';
    } catch (e) {
      return '';
    }
  }

  parseViews(viewsStr: string | number): number {
    if (typeof viewsStr === 'number') return viewsStr;
    if (!viewsStr) return 0;

    const str = viewsStr.toString().toLowerCase().replace(/[^0-9.kmb]/g, '');
    const num = parseFloat(str);

    if (isNaN(num)) return 0;

    if (str.includes('k')) return Math.floor(num * 1000);
    if (str.includes('m')) return Math.floor(num * 1000000);
    if (str.includes('b')) return Math.floor(num * 1000000000);

    return Math.floor(num) || 0;
  }

  parseISO8601Duration(duration: string): string {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return '0:00';

    const hours = parseInt(match[1] || '0');
    const minutes = parseInt(match[2] || '0');
    const seconds = parseInt(match[3] || '0');

    let result = '';
    if (hours > 0) {
        result += `${hours}:`;
    }
    result += `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    return result;
  }

  // Enhanced metadata evaluation focusing on >1min content
  async evaluate_video_metadata(video: YouTubeVideoData, subtopic: string, summary: string): Promise<{ score: number; reason: string }> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are evaluating a YouTube video's relevance for learning.
Rate the video's potential to teach the subtopic well (0-10) based *only* on its title, description, duration, and channel.
Compare these metadata points directly against the provided summary for the subtopic.

Focus on educational value regardless of duration (as long as it's not a Short).
Consider:
- How well the title matches the learning objective
- Quality indicators in the description
- Channel credibility for educational content
- Relevance to the specific subtopic
- Source quality (Google results may have better relevance ranking)

Provide a clear, concise reason for your score.
Output JSON: { "score": number, "reason": "Specific reason based on metadata analysis." }`
      },
      {
        role: 'user',
        content: `Subtopic to learn: ${subtopic}

Video Metadata:
Title: ${video.title}
Description: ${video.snippet.substring(0, 400)}...
Views: ${video.views.toLocaleString()}
Channel: ${video.channel}
Duration: ${video.duration}
Uploaded: ${video.uploaded}
Source: ${video.source || 'unknown'}

Summary (for comparison): ${summary}`
      }
    ];

    try {
      const response = await azure_chat_completion(messages);
      const parsed = JSON.parse(response.match(/\{.*\}/)?.[0] || '{}');
      return {
        score: parsed.score || 0,
        reason: parsed.reason || 'Metadata evaluation'
      };
    } catch (e) {
      console.error(`❌ Metadata evaluation failed for video "${video.title}": ${e}`);
      return { score: 0, reason: 'Evaluation failed' };
    }
  }

  // Process video with enhanced logging
  async process_video(video: YouTubeVideoData, summary: string, subtopic: string): Promise<{
    video: YouTubeVideoData;
    hasTranscript: boolean;
    bestResult?: any;
    score: number;
    reason: string;
    processingType: 'metadata';
  }> {
    const videoId = video.videoId;
    if (!videoId) {
      return { video, hasTranscript: false, score: 0, reason: 'Invalid video ID', processingType: 'metadata' };
    }

    const durationMin = this.parseDurationToMinutes(video.duration);
    const sourceInfo = video.source ? ` [${video.source.toUpperCase()}]` : '';
    console.log(`🎬 Processing: ${video.title.substring(0, 50)}...${sourceInfo} (${video.duration} = ${durationMin.toFixed(1)}min)`);

    const metadataResult = await this.evaluate_video_metadata(video, subtopic, summary);

    return {
      video,
      hasTranscript: false,
      score: metadataResult.score,
      reason: `${video.source || 'Unknown'} source analysis: ${metadataResult.reason}`,
      processingType: 'metadata'
    };
  }

  // Enhanced video finder with hybrid scraping
  async find_best_youtube_video(topic: string, subtopic: string, summary: string): Promise<{ videoUrl: string; timestamp?: number; reason: string }> {
    console.log(`🎯 Finding best YouTube video via hybrid scraping for: ${topic} - ${subtopic}`);
    console.log(`📋 Using summary: ${summary.substring(0, 100)}...`);

    const candidates = await this.search_youtube_videos_parallel(topic, subtopic, summary);

    if (candidates.length === 0) {
      return {
        videoUrl: '',
        reason: 'No YouTube videos found for the given topic and subtopic.'
      };
    }

    const googleCount = candidates.filter(v => v.source === 'google').length;
    const youtubeCount = candidates.filter(v => v.source === 'youtube').length;

    console.log(`🚀 Processing ${Math.min(candidates.length, 25)} candidates in reasoning batches...`);
    console.log(`📊 Candidate stats: ${candidates.length} total videos (${googleCount} Google, ${youtubeCount} YouTube)`);

    const topCandidates = candidates.slice(0, 25);
    const batchSize = 5;
    const allResults: any[] = [];

    for (let i = 0; i < topCandidates.length; i += batchSize) {
      const batch = topCandidates.slice(i, i + batchSize);
      console.log(`⚡ Reasoning batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(topCandidates.length/batchSize)} (${batch.length} videos)...`);

      const batchPromises = batch.map(async (video, index) => {
        const globalIndex = i + index + 1;
        const durationMin = this.parseDurationToMinutes(video.duration);
        const sourceInfo = video.source ? ` [${video.source.toUpperCase()}]` : '';
        console.log(`🔍 [${globalIndex}] Reasoning: ${video.title.substring(0, 40)}...${sourceInfo} (${durationMin.toFixed(1)}min, ${video.views.toLocaleString()} views)`);

        const result = await this.process_video(video, summary, subtopic);

        console.log(`📊 [${globalIndex}] Score: ${result.score}/10 - ${result.reason.substring(0, 60)}...`);

        return result;
      });

      const batchResults = await Promise.all(batchPromises);
      allResults.push(...batchResults);

      // Look for excellent matches early
      const excellentMatch = allResults.find(r => r.score >= 8); // Check allResults in case excellent match was in previous batch
      if (excellentMatch) {
        const sourceInfo = excellentMatch.video.source ? ` [${excellentMatch.video.source.toUpperCase()}]` : '';
        console.log(`🎉 EXCELLENT match found! Score ${excellentMatch.score}/10 - "${excellentMatch.video.title.substring(0, 40)}..."${sourceInfo}`);
        break;
      }

      // Look for good matches after first two batches
      if (i >= batchSize * 2) {
        const goodMatch = allResults.find(r => r.score >= 7);
        if (goodMatch) {
          console.log(`✅ GOOD match found after ${allResults.length} videos! Score ${goodMatch.score}/10`);
          break;
        }
      }

      if (i + batchSize < topCandidates.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (allResults.length === 0) {
      return {
        videoUrl: candidates[0]?.url || '',
        reason: 'No videos could be processed successfully.'
      };
    }

    console.log(`📈 Reasoning complete: Processed ${allResults.length} videos. Selecting best match...`);

    const bestVideo = allResults.sort((a, b) => b.score - a.score)[0];
    const durationInfo = `${bestVideo.video.duration} (${this.parseDurationToMinutes(bestVideo.video.duration).toFixed(1)} min)`;
    const sourceInfo = bestVideo.video.source ? ` [${bestVideo.video.source.toUpperCase()}]` : '';

    console.log(`✅ Selected best hybrid video: "${bestVideo.video.title.substring(0, 50)}..."${sourceInfo}`);
    console.log(`   Score: ${bestVideo.score}/10, Duration: ${durationInfo}, Views: ${bestVideo.video.views.toLocaleString()}`);

    return {
      videoUrl: bestVideo.video.url,
      reason: `Hybrid search result: ${bestVideo.reason} | Video: "${bestVideo.video.title}" | Duration: ${durationInfo} | Source: ${bestVideo.video.source || 'unknown'}`
    };
  }

  async select_best_video(
    allVideos: YouTubeVideoData[],
    subtopic: string,
    topic: string,
    intent: string,
    summary: string
    ): Promise<any | null> {
    console.log(`🎬 Selecting best video for subtopic: "${subtopic}" (Hybrid results)`);
    console.log(`Total videos to consider: ${allVideos.length}`);

    if (allVideos.length === 0) {
        return null;
    }

    // Log source distribution
    const googleCount = allVideos.filter(v => v.source === 'google').length;
    const youtubeCount = allVideos.filter(v => v.source === 'youtube').length;
    console.log(`📊 Source distribution: ${googleCount} from Google, ${youtubeCount} from YouTube`);

    const evaluatedVideos = await executeInParallel(
        allVideos,
        async (video) => await this.process_video(video, summary, subtopic),
        Settings.MAX_CONCURRENT_REQUESTS,
        Settings.DELAY_BETWEEN_BATCH_FETCHES_MS
    );

    const relevantVideos = evaluatedVideos.filter(
        (result): result is NonNullable<typeof result> =>
            result !== null && result.score >= 5
    );

    if (relevantVideos.length === 0) {
        console.warn(`⚠️ No relevant videos found after reasoning evaluation for "${subtopic}".`);
        return null;
    }

    relevantVideos.sort((a, b) => b.score - a.score);

    const bestVideoResult = relevantVideos[0];
    const durationMin = this.parseDurationToMinutes(bestVideoResult.video.duration);
    const sourceInfo = bestVideoResult.video.source ? ` [${bestVideoResult.video.source.toUpperCase()}]` : '';

    console.log(`✅ Best hybrid video selected for "${subtopic}": ${bestVideoResult.video.title}${sourceInfo}`);
    console.log(`   Score: ${bestVideoResult.score}/10, Duration: ${durationMin.toFixed(1)}min, Views: ${bestVideoResult.video.views.toLocaleString()}`);

    return bestVideoResult;
  }
}


// Updated main function to handle summaries and print them
export async function runCourseAgent(topic: string, intent: string) {
  console.log(`\n🎓 Starting course generation for topic: ${topic}`);

  const overallStartTime = Date.now();

  try {
    // STAGE 2: SSR Foundation Building
    const ssrAgent = new SSRFoundationAgent();
    const webOfTruth = await ssrAgent.build_topic_report(topic, intent);

    // STAGE 3: Subtopic Identification
    const spiderKing = new SpiderKing();
    const subtopics = await spiderKing.identify_subtopics_from_web_of_truth(
      webOfTruth,
      topic,
      intent
    );

    if (subtopics.length === 0) {
      throw new Error("❌ No subtopics could be extracted.");
    }

    // STAGE 4: Info Spider Summarization
    const infoSpider = new InfoSpiderAgent();
    const subtopicReports = await infoSpider.investigate_all_subtopics(
      subtopics,
      topic,
      intent
    );

    // STAGE 5: YouTube Search using summaries
    const ytSpider = new YouTubeSpiderAgent();
    const ytVideos = await executeInParallel(
      subtopicReports,
      async (report) => {
        const videoResult = await ytSpider.find_best_youtube_video(
          topic,
          report.subtopic,
          report.summary
        );
        return videoResult;
      },
      Settings.MAX_CONCURRENT_REQUESTS
    );

    const totalTime = Math.round((Date.now() - overallStartTime) / 1000);
 
 
return {
  topic,
  intent,
  processingTime: totalTime,
  subtopics: subtopicReports.map((report, index) => {
    const video = ytVideos[index] || null;

    return {
      subtopic: report.subtopic,
      summary: report.summary,
      report: report.report,
      video: video?.videoUrl || null,
      reason: video?.reason || null
    };
  })
};

  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}
