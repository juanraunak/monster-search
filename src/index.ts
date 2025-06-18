import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs/promises';
import * as readline from 'readline';
import { encode } from 'gpt-tokenizer';
import { YouTube } from 'youtube-sr';

// For sentence transformers equivalent, we'll use a simple similarity function
// For concurrent operations, we'll use Promise.allSettled
// For fuzzy matching, we'll implement a simple version

// Load environment variables (equivalent to load_dotenv())
import * as dotenv from 'dotenv';
dotenv.config();

// Query and website count
const q = 10;
const websites = 5;

// === Configuration ===
class Settings {
    // Google Search API
    static readonly GOOGLE_API_KEY = "AIzaSyCk4DYKCm5sSLz63aFUlVk8E04QPSvjXT8";
    static readonly GOOGLE_CX = "53459b243c2c34e0c";
    
    // YouTube API
    static readonly YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "AIzaSyBJo08Dpf3we5cqo9ioNVFVTxuzf-UNaVs";
    static readonly MAX_RESULTS_PER_SUBTOPIC = 9;
    
    // Azure OpenAI
    static readonly AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || "2be1544b3dc14327b60a870fe8b94f35";
    static readonly AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "https://notedai.openai.azure.com";
    static readonly AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-06-01";
    static readonly AZURE_OPENAI_DEPLOYMENT_ID = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";
}

// === Global Variables ===
let total_prompt_tokens = 0;
let total_completion_tokens = 0;

// Initialize components (equivalent to sentence transformers and tiktoken)
// We'll implement a simple sentence similarity function instead
// const model = SentenceTransformer("all-MiniLM-L6-v2") - replaced with simple function
// const ENCODING = tiktoken.encoding_for_model("gpt-4o") - using gpt-tokenizer

// Headers for direct API calls
const headers = {
    "Content-Type": "application/json",
    "api-key": Settings.AZURE_OPENAI_API_KEY
};

// === Types ===
interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    name?: string;
}

interface SearchResult {
    query: string;
    summary: string;
    pages: number;
}

interface VideoResult {
    title: string;
    url: string;
    channel: string;
    published: string;
    match: number;
}

interface CourseJson {
    topic: string;
    subtopics: string[];
}

interface ExtractedData {
    topic: string;
    intent: string;
}

// === Utility Functions ===
function count_tokens_from_messages(messages: ChatMessage[], model: string = "gpt-4o"): number {
    const tokens_per_message = 3;
    const tokens_per_name = 1;

    let num_tokens = 0;
    for (const message of messages) {
        num_tokens += tokens_per_message;
        for (const [key, value] of Object.entries(message)) {
            num_tokens += encode(value).length;
            if (key === "name") {
                num_tokens += tokens_per_name;
            }
        }
    }
    num_tokens += 3;
    return num_tokens;
}

async function azure_chat_completion(messages: ChatMessage[]): Promise<string> {
    const url = `${Settings.AZURE_OPENAI_ENDPOINT}/openai/deployments/${Settings.AZURE_OPENAI_DEPLOYMENT_ID}/chat/completions?api-version=${Settings.AZURE_OPENAI_API_VERSION}`;

    const prompt_tokens = count_tokens_from_messages(messages, "gpt-4o");

    const response = await axios.post(url, {
        messages: messages,
        temperature: 0.7
    }, { headers });

    const content = response.data.choices[0].message.content;
    const completion_tokens = encode(content).length;

    total_prompt_tokens += prompt_tokens;
    total_completion_tokens += completion_tokens;

    console.log(`📏 Tokens - Prompt: ${prompt_tokens} | Completion: ${completion_tokens} | Total: ${prompt_tokens + completion_tokens}`);
    return content;
}

// === Chat Function to Extract Intent ===
async function extract_intent_chat(): Promise<ExtractedData | null> {
    console.log("\n" + "=".repeat(60));
    console.log("🤖 AI RESEARCH ASSISTANT - INTENT EXTRACTION");
    console.log("=".repeat(60));
    console.log("Let's define what you want to research and from what perspective.");
    console.log("Type 'exit' or 'quit' to stop.\n");

    const system_prompt: ChatMessage = {
        role: "system",
        content: `You are a learning intent extractor. Your job is to define:

{
  "topic": "",
  "intent": ""
}

Definitions:
- "topic" = the subject they want to learn (e.g., "keyboard", "Moses", "statistics")
- "intent" = the learner's starting point (how much they know), and the *approach or perspective* they want to take (e.g., emotional journey, technical mastery, performance growth, worship, etc.)

Your job is to **ask short, focused questions** until BOTH are clear.

✅ When topic is vague or ambiguous, clarify:  
- "Do you mean building a keyboard or learning to play one?"

✅ When intent is vague or shallow, ask:  
1. "Have you learned or tried this before? What's your current level?"  
2. "How do you want to learn it ? the *approach or perspective* they want to take

✅ Your goal is a clear picture of **where they are now and how they want to go deeper.**

Once both are clear:
1. Output the JSON in this exact format: {"topic": "...", "intent": "..."}
2. Then say: "JSON filled. Starting research..."

Do not ask why they want to learn. End immediately after the JSON.`
    };

    const messages: ChatMessage[] = [];
    let extracted_json: ExtractedData | null = null;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const askQuestion = (question: string): Promise<string> => {
        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                resolve(answer);
            });
        });
    };

    try {
        while (true) {
            const prompt = await askQuestion("You: ");
            if (prompt.toLowerCase() === "exit" || prompt.toLowerCase() === "quit") {
                console.log("👋 Goodbye!");
                return null;
            }

            messages.push({ role: "user", content: prompt });
            process.stdout.write("Assistant: ");

            // Simulate streaming by getting the full response and printing it
            const assistant_content = await azure_chat_completion([system_prompt, ...messages.slice(-10)]);
            console.log(assistant_content);

            messages.push({ role: "assistant", content: assistant_content });

            // Extract JSON from response
            if (assistant_content.includes("{") && assistant_content.includes("}")) {
                try {
                    // Find JSON in the response
                    const start = assistant_content.indexOf("{");
                    const end = assistant_content.indexOf("}", start) + 1;
                    const json_str = assistant_content.substring(start, end);
                    extracted_json = JSON.parse(json_str);
                    
                    if (extracted_json && "topic" in extracted_json && "intent" in extracted_json) {
                        console.log(`\n\n✅ Extracted: ${JSON.stringify(extracted_json)}`);
                        return extracted_json;
                    }
                } catch (e) {
                    // Continue chat if JSON parsing fails
                }
            }

            console.log("\n");
        }
    } catch (error) {
        console.log(`\n❌ Error: ${error}`);
        console.log("Please try again.");
    } finally {
        rl.close();
    }

    return null;
}

// === Research Functions ===
async function generate_intent_based_query(topic: string, intent: string): Promise<string> {
    console.log(`🎯 Generating intent-based search query...`);
    const messages: ChatMessage[] = [
        {
            role: "system",
            content: "You are a search query specialist. Create a focused Google search query that combines the topic with the user's specific intent or perspective."
        },
        {
            role: "user",
            content: `Topic: "${topic}"
User's Intent/Perspective: "${intent}"

Create a single, focused Google search query (3-8 words) that will find results specifically related to the user's intent about this topic. 

Examples:
- Topic: "Moses in the Bible", Intent: "leadership qualities" → "Moses leadership qualities biblical"
- Topic: "Climate change", Intent: "economic impact" → "climate change economic impact costs"

Return only the search query, nothing else.`
        }
    ];
    
    const query = (await azure_chat_completion(messages)).trim().replace(/"/g, '');
    console.log(`🔍 Generated query: '${query}'`);
    return query;
}

async function google_search(query: string, num_results: number = websites): Promise<string[]> {
    console.log(`🔍 Searching Google: '${query}'`);
    const params = new URLSearchParams({
        q: query,
        cx: Settings.GOOGLE_CX,
        key: Settings.GOOGLE_API_KEY,
        num: num_results.toString()
    });
    const url = `https://www.googleapis.com/customsearch/v1?${params}`;
    
    let response = await axios.get(url);
    if (response.status === 429) {
        console.log("⚠️ Rate limited, waiting 2 seconds...");
        await new Promise(resolve => setTimeout(resolve, 2000));
        response = await axios.get(url);
    }
    
    const data = response.data;
    await new Promise(resolve => setTimeout(resolve, 200));
    const results = (data.items || []).map((item: any) => item.link).slice(0, num_results);
    console.log(`✅ Found ${results.length} results for '${query}'`);
    return results;
}

async function scrape_page_text(url: string): Promise<string> {
    try {
        console.log(`🌐 Scraping: ${url.substring(0, 60)}...`);
        const res = await axios.get(url, { timeout: 5000 });
        const $ = cheerio.load(res.data);
        return $.text().replace(/\s+/g, " ").trim().substring(0, 3000);
    } catch (error) {
        console.log(`❌ Failed to scrape ${url}: ${error}`);
        return "";
    }
}

async function summarize_pages(urls: string[], topic: string, intent: string): Promise<[string, number]> {
    console.log(`📚 Summarizing ${urls.length} pages with intent focus...`);
    const contents: string[] = [];
    for (const url of urls) {
        const text = await scrape_page_text(url);
        if (text) {
            contents.push(text);
        }
    }
    
    const combined_text = contents.join("\n\n");
    
    if (!combined_text) {
        console.log("⚠️ No content found for summarization");
        return ["", 0];
    }

    const prompt: ChatMessage[] = [
        {
            role: "system",
            content: "You are a research assistant that summarizes information with laser focus on the user's specific intent and perspective."
        },
        {
            role: "user",
            content: `Topic: "${topic}"  
User's Intent/Perspective: "${intent}"

Summarize the following content, but ONLY focus on information that directly relates to the user's intent. Ignore general information that doesn't serve their specific perspective.

Key instructions:
- Extract only content that addresses the user's intent
- Organize insights around the user's perspective
- Skip generic or unrelated information
- Be specific and detailed about relevant aspects

Content to analyze:
${combined_text}`
        }
    ];
    
    const summary = await azure_chat_completion(prompt);
    console.log(`✅ Intent-focused summary completed (${summary.length} chars)`);
    return [summary, contents.length];
}

async function refine_queries(summary: string, topic: string, intent: string): Promise<string[]> {
    console.log("🧠 Generating refined queries based on intent...");
    const messages: ChatMessage[] = [
        {
            role: "system",
            content: "You are a research specialist who creates targeted search queries that dig deeper into specific aspects related to the user's intent."
        },
        {
            role: "user",
            content: `Topic: "${topic}"  
User's Intent: "${intent}"

Based on this summary, generate 7 specific search queries that will find MORE information specifically about the USER'S INTENT. Each query should:
- Target a different aspect of the user's intent (VERY IMPORTENT)
- Be specific enough to find focused results
- Use 3-6 words maximum
- Avoid generic terms

Current summary:
${summary}

Format: Return only the search queries, one per line, no numbering or bullets.`
        }
    ];

    const raw_queries = await azure_chat_completion(messages);
    const queries = raw_queries.split("\n")
        .map(q => q.replace(/^[-•\s]+/, '').trim())
        .filter(q => q.trim() && q.length > 5);
    
    console.log("🔍 Refined intent-based queries:");
    for (let i = 0; i < queries.length; i++) {
        console.log(`  ${i + 1}. ${queries[i]}`);
    }
    return queries;
}

async function process_query(query: string, topic: string, intent: string): Promise<SearchResult> {
    const urls = await google_search(query);
    const [summary, pages_used] = await summarize_pages(urls, topic, intent);
    return { query: query, summary: summary, pages: pages_used };
}

async function run_refined_queries(queries: string[], topic: string, intent: string): Promise<SearchResult[]> {
    console.log(`🚀 Running ${queries.length} refined queries in parallel...`);
    const results: SearchResult[] = [];
    
    // Use Promise.allSettled to match ThreadPoolExecutor behavior
    const promises = queries.map(q => process_query(q, topic, intent));
    const settled_results = await Promise.allSettled(promises);
    
    for (let i = 0; i < settled_results.length; i++) {
        const result = settled_results[i];
        const query = queries[i];
        if (result.status === 'fulfilled') {
            results.push(result.value);
        } else {
            console.log(`❌ Error processing query '${query}': ${result.reason}`);
        }
    }
    
    return results;
}

async function generate_course_content(summaries: Array<{summary: string}>, topic: string, intent: string): Promise<string> {
    console.log("📚 Creating course with video-search optimized subtopics...");
    const combined = summaries.map(s => s.summary).join("\n\n");
    
    const prompt: ChatMessage[] = [
        {
            role: "system",
            content: `You are a course designer creating a focused and effective course based ONLY on the given research summary. Your goal is to help the learner fully understand the topic by the end of the course.

Strictly follow these rules:

Context:
Topic: "${topic}"
Perspective/Intent: "${intent}"

Keep in mind everthing should some form the reaserch summry and not any internal knowledge !!

Output Format:
# [Course Title]
- [Subtopic 1]
- [Subtopic 2]
...

Output Requirements:
1. Course Title: Create a clear, creative, and **short** title that is highly YouTube-searchable let this be 2 words no fluff just the main topic.
2. Subtopics List: Generate a list of concise, **2–4 word** subtopics.

Subtopic Guidelines:
- Each subtopic must be **YouTube-search friendly** when combined with the topic
- DO NOT include vague or motivational subtopics (e.g., "Stay Focused", "Why It Matters")
- Use only **concepts, keywords, or patterns from the research summary**
- DO NOT use your own external knowledge. Only use what is present in the research summary.
- You may generate as many subtopics as needed to complete the learning intent
- Avoid special characters like curly quotes or apostrophes.
- this should be plain text no  "\ u2019" all this

DO NOT add any intros, explanations, or section headers other than the title and bullet list.`
        },
        {
            role: "user",
            content: `Research Summary Content:
${combined}`
        }
    ];

    return await azure_chat_completion(prompt);
}

function convert_course_to_json(course_content: string): CourseJson {
    console.log("🔄 Converting course content to JSON format...");
    
    const lines = course_content.trim().split('\n');
    let topic = "";
    const subtopics: string[] = [];
    
    for (const line of lines) {
        const trimmed_line = line.trim();
        if (trimmed_line.startsWith('#')) {
            // Extract topic from title
            topic = trimmed_line.replace('#', '').trim();
        } else if (trimmed_line.startsWith('-')) {
            // Extract subtopic
            const subtopic = trimmed_line.replace('-', '').trim();
            if (subtopic) {
                subtopics.push(subtopic);
            }
        }
    }
    
    const course_json: CourseJson = {
        topic: topic,
        subtopics: subtopics
    };
    
    console.log(`✅ JSON created with topic: '${topic}' and ${subtopics.length} subtopics`);
    return course_json;
}

// === YouTube Search Functions ===
// Simple fuzzy matching function (equivalent to fuzzywuzzy)
function fuzz_partial_token_sort_ratio(str1: string, str2: string): number {
    const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const s1 = normalize(str1);
    const s2 = normalize(str2);
    
    if (s1.includes(s2) || s2.includes(s1)) return 100;
    
    const words1 = s1.split(/\s+/);
    const words2 = s2.split(/\s+/);
    
    let matches = 0;
    for (const word1 of words1) {
        for (const word2 of words2) {
            if (word1 === word2 || word1.includes(word2) || word2.includes(word1)) {
                matches++;
                break;
            }
        }
    }
    
    return Math.round((matches / Math.max(words1.length, words2.length)) * 100);
}

async function search_youtube_videos(topic: string, subtopic: string, max_results: number): Promise<VideoResult[]> {
    const query = `${subtopic} ${topic}`;
    console.log(`\n🔍 Searching YouTube for: '${query}'`);
    const results = await YouTube.search(query, { type: "video", limit: 30 });

    const videos: VideoResult[] = [];
    for (const video of results) {
        if (!video.duration || video.duration < 60) {
            continue;  // Skip Shorts
        }
        const title = video.title || '';
        const channel = video.channel?.name || '';
        const published = video.uploadedAt || '';
        const url = video.url;
        const score_topic = fuzz_partial_token_sort_ratio(topic.toLowerCase(), title.toLowerCase());
        const score_sub = fuzz_partial_token_sort_ratio(subtopic.toLowerCase(), title.toLowerCase());
        let match = 1;
        if (score_topic > 40 && score_sub > 60) {
            match = 4;
        } else if (score_topic > 30 && score_sub > 40) {
            match = 3;
        } else if (score_sub > 60) {
            match = 3;
        } else if (score_topic > 50) {
            match = 2;
        }
        videos.push({
            title,
            url,
            channel,
            published,
            match
        });
    }
    videos.sort((a, b) => {
        if (a.match !== b.match) return b.match - a.match;
        return a.title.localeCompare(b.title);
    });
    
    return videos.slice(0, max_results);
}

async function run_youtube_search(course_json: CourseJson): Promise<Record<string, VideoResult[]>> {
    console.log(`\n${"=".repeat(60)}`);
    console.log("🎬 YOUTUBE VIDEO SEARCH RESULTS");
    console.log(`${"=".repeat(60)}`);
    
    const topic = course_json.topic;
    const subtopics = course_json.subtopics;
    const all_results: Record<string, VideoResult[]> = {};
    
    for (const subtopic of subtopics) {
        console.log(`\n📚 Subtopic: ${subtopic}`);
        const videos = await search_youtube_videos(topic, subtopic, Settings.MAX_RESULTS_PER_SUBTOPIC);
        all_results[subtopic] = videos;
        
        for (let i = 0; i < videos.length; i++) {
            const vid = videos[i];
            console.log(`${i + 1}. ${vid.title} (${vid.channel})`);
            console.log(`   🔗 ${vid.url}`);
        }
    }
    
    return all_results;
}


async function research_pipeline(topic: string, intent: string): Promise<[string, string]> {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🔬 STARTING RESEARCH`);
    console.log(`📋 Topic: ${topic}`);
    console.log(`🎯 Intent: ${intent}`);
    console.log(`${"=".repeat(50)}\n`);
    
    // Layer 1: Intent-based initial research
    console.log(`\n${"=".repeat(30)}`);
    console.log(` LAYER 1: INTENT-FOCUSED RESEARCH `);
    console.log(`${"=".repeat(30)}`);
    
    const initial_query = await generate_intent_based_query(topic, intent);
    const urls = await google_search(initial_query);
    const [layer1_summary, layer1_pages] = await summarize_pages(urls, topic, intent);
    
    if (!layer1_summary) {
        return ["❌ No results found in initial search", ""];
    }
    
    // Layer 2: Refined research based on intent
    console.log(`\n${"=".repeat(30)}`);
    console.log(` LAYER 2: DEEP DIVE RESEARCH `);
    console.log(`${"=".repeat(30)}`);
    const refined_queries = await refine_queries(layer1_summary, topic, intent);
    const refined_results = await run_refined_queries(refined_queries, topic, intent);
    
    // Prepare all summaries for course creation
    const all_summaries = [
        { source: "Primary Intent-Based Research", summary: layer1_summary, pages: layer1_pages }
    ];
    for (const res of refined_results) {
        all_summaries.push({
            source: res.query,
            summary: res.summary,
            pages: res.pages
        });
    }
    
    // Generate course content
    console.log(`\n${"=".repeat(30)}`);
    console.log(` COURSE CREATION `);
    console.log(`${"=".repeat(30)}`);
    const course_content = await generate_course_content(all_summaries, topic, intent);
    
    // Create detailed report
    const total_layer2_pages = refined_results.reduce((sum, res) => sum + res.pages, 0);
    const total_pages = layer1_pages + total_layer2_pages;
    
    let report = `\n${"=".repeat(60)}\n`;
    report += "🎓 INTENT-FOCUSED LEARNING COURSE\n";
    report += `${"=".repeat(60)}\n\n`;
    report += `📋 TOPIC: ${topic}\n`;
    report += `🎯 PERSPECTIVE: ${intent}\n\n`;
    report += `📊 RESEARCH BASIS:\n`;
    report += `- Websites analyzed: ${total_pages}\n`;
    report += `- Search queries executed: ${1 + refined_queries.length}\n\n`;
    report += `${"=".repeat(60)}\n`;
    report += "📚 COURSE CONTENT\n";
    report += `${"=".repeat(60)}\n\n`;
    report += course_content;
    
    return [report, course_content];
}

function print_token_summary(): void {
    const total = total_prompt_tokens + total_completion_tokens;
    console.log(`\n${"=".repeat(40)}`);
    console.log("📦 FINAL TOKEN USAGE SUMMARY");
    console.log(`${"=".repeat(40)}`);
    console.log(`📏 Total prompt tokens: ${total_prompt_tokens.toLocaleString()}`);
    console.log(`📏 Total completion tokens: ${total_completion_tokens.toLocaleString()}`);
    console.log(`📊 Grand total: ${total.toLocaleString()} tokens`);
    console.log(`${"=".repeat(40)}`);
}

// === Main Application ===
async function main(): Promise<void> {
    try {
        // Step 1: Extract intent through chat
        const extracted_data = await extract_intent_chat();
    
        if (!extracted_data) {
            console.log("👋 Research session cancelled.");
            return;
        }
        
        const topic = extracted_data.topic;
        const intent = extracted_data.intent;
        
        console.log(`\n🚀 Starting deep research...`);
        console.log(`📋 Topic: ${topic}`);
        console.log(`🎯 Intent: ${intent}`);
        
        // Step 2: Run research pipeline
        const [result, course_content] = await research_pipeline(topic, intent);
        
        if (!course_content) {
            console.log("❌ Research failed, cannot proceed to YouTube search");
            return;
        }
        
        // Step 3: Convert to JSON for YouTube search
        const course_json = convert_course_to_json(course_content);
        
        // Step 4: Run YouTube search
        const youtube_results = await run_youtube_search(course_json);
        
        // Step 5: Display results
        console.log(result);
        
        // Step 6: Create comprehensive output
        console.log(`\n${"=".repeat(60)}`);
        console.log("📊 COMPLETE PIPELINE OUTPUT");
        console.log(`${"=".repeat(60)}`);
        
        console.log(`\n🔍 GENERATED JSON:`);
        console.log(JSON.stringify(course_json, null, 2));
        
        console.log(`\n🎬 YOUTUBE SEARCH SUMMARY:`);
        const total_videos = Object.values(youtube_results).reduce((sum, videos) => sum + videos.length, 0);
        console.log(`- Total subtopics: ${course_json.subtopics.length}`);
        console.log(`- Total videos found: ${total_videos}`);
        
        print_token_summary(); 

    } catch (error) {
        console.error("💥 Unexpected error:", error);
    }
}

// Optional: Auto-run the function if needed
main();