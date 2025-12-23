import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import { chromium, Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from "playwright";
import dotenv from "dotenv";
import UserAgent from "user-agents";
import { getError } from "./helpers/get_error";
import { FlareSolverrClient } from "./flaresolverr";
import { ScraperCache } from "./cache";
import { RetryHandler } from "./retry";

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());

const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || "False").toUpperCase() === "TRUE";
const MAX_CONCURRENT_PAGES = Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_PAGES ?? "10", 10) || 10);

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

// ✅ Added FlareSolverr configuration
const ENABLE_CLOUDFLARE_BYPASS = (process.env.ENABLE_CLOUDFLARE_BYPASS || "false").toLowerCase() === "true";
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://flaresolverr:8191";
const FLARESOLVERR_TIMEOUT = parseInt(process.env.FLARESOLVERR_TIMEOUT || "60000", 10);

// ✅ Added Cache configuration via environment variables
const CACHE_ENABLED = (process.env.CACHE_ENABLED || "false").toLowerCase() === "true";

// ✅ Initialize FlareSolverr client
let flareSolverr: FlareSolverrClient | null = null;
if (ENABLE_CLOUDFLARE_BYPASS) {
	flareSolverr = new FlareSolverrClient(FLARESOLVERR_URL, FLARESOLVERR_TIMEOUT);
	console.log("[Playwright] ✓ FlareSolverr integration enabled");
}

// ✅ Initialize Cache client
const cache = new ScraperCache();
console.log(`[Playwright] Cache system: ${cache.isEnabled() ? "✅ ENABLED" : "❌ DISABLED"}`);

// ✅ Initialize Retry Handler
const retryHandler = new RetryHandler();

class Semaphore {
	private permits: number;
	private queue: (() => void)[] = [];

	constructor(permits: number) {
		this.permits = permits;
	}

	async acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits--;
			return Promise.resolve();
		}

		return new Promise<void>(resolve => {
			this.queue.push(resolve);
		});
	}

	release(): void {
		this.permits++;
		if (this.queue.length > 0) {
			const nextResolve = this.queue.shift();
			if (nextResolve) {
				this.permits--;
				nextResolve();
			}
		}
	}

	getAvailablePermits(): number {
		return this.permits;
	}

	getQueueLength(): number {
		return this.queue.length;
	}
}
const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);

const AD_SERVING_DOMAINS = [
	"doubleclick.net",
	"adservice.google.com",
	"googlesyndication.com",
	"googletagservices.com",
	"googletagmanager.com",
	"google-analytics.com",
	"adsystem.com",
	"adservice.com",
	"adnxs.com",
	"ads-twitter.com",
	"facebook.net",
	"fbcdn.net",
	"amazon-adsystem.com",
];

interface UrlModel {
	url: string;
	wait_after_load?: number;
	timeout?: number;
	headers?: { [key: string]: string };
	check_selector?: string;
	skip_tls_verification?: boolean;
	bypass_cloudflare?: boolean;
	cookies?: any[];
	use_cache?: boolean;
	max_retries?: number; // ✅ Added max_retries parameter
}

let browser: Browser;

const initializeBrowser = async () => {
	if (!browser) {
		browser = await chromium.launch({
			headless: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-accelerated-2d-canvas", "--no-first-run", "--no-zygote", "--disable-gpu"],
		});
	}
};

const createContext = async (skipTlsVerification: boolean = false, customUserAgent?: string, cookies?: any[]) => {
	const userAgent = customUserAgent || new UserAgent().toString();
	const viewport = { width: 1280, height: 800 };

	const contextOptions: any = {
		userAgent,
		viewport,
		ignoreHTTPSErrors: skipTlsVerification,
	};

	if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
		contextOptions.proxy = {
			server: PROXY_SERVER,
			username: PROXY_USERNAME,
			password: PROXY_PASSWORD,
		};
	} else if (PROXY_SERVER) {
		contextOptions.proxy = {
			server: PROXY_SERVER,
		};
	}

	const newContext = await browser.newContext(contextOptions);

	if (cookies && cookies.length > 0) {
		await newContext.addCookies(cookies);
		console.log(`[Playwright] ✓ Injected ${cookies.length} cookies`);
	}

	if (BLOCK_MEDIA) {
		await newContext.route("**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}", async (route: Route, request: PlaywrightRequest) => {
			await route.abort();
		});
	}

	await newContext.route("**/*", (route: Route, request: PlaywrightRequest) => {
		const requestUrl = new URL(request.url());
		const hostname = requestUrl.hostname;

		if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
			return route.abort();
		}
		return route.continue();
	});

	return newContext;
};

const shutdownBrowser = async () => {
	if (browser) {
		await browser.close();
	}
};

const isValidUrl = (urlString: string): boolean => {
	try {
		new URL(urlString);
		return true;
	} catch (_) {
		return false;
	}
};

const convertFlareSolverrCookies = (cookies: any[], url: string) => {
	const urlObj = new URL(url);
	return cookies.map(cookie => ({
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain || urlObj.hostname,
		path: cookie.path || "/",
		expires: cookie.expires || -1,
		httpOnly: cookie.httpOnly || false,
		secure: cookie.secure || false,
		sameSite: (cookie.sameSite as "Strict" | "Lax" | "None") || "Lax",
	}));
};

const scrapePage = async (page: Page, url: string, waitUntil: "load" | "networkidle", waitAfterLoad: number, timeout: number, checkSelector: string | undefined) => {
	console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
	const response = await page.goto(url, { waitUntil, timeout });

	if (waitAfterLoad > 0) {
		await page.waitForTimeout(waitAfterLoad);
	}

	if (checkSelector) {
		try {
			await page.waitForSelector(checkSelector, { timeout });
		} catch (error) {
			throw new Error("Required selector not found");
		}
	}

	let headers = null,
		content = await page.content();
	let ct: string | undefined = undefined;
	if (response) {
		headers = await response.allHeaders();
		ct = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
		if (ct && (ct.toLowerCase().includes("application/json") || ct.toLowerCase().includes("text/plain"))) {
			content = (await response.body()).toString("utf8");
		}
	}

	// ✅ If status code indicates temporary error, throw for RetryHandler to catch
	if (response && (response.status() === 429 || (response.status() >= 500 && response.status() < 600))) {
		const error: any = new Error(`Scrape failed with retryable status: ${response.status()}`);
		error.status = response.status();
		throw error;
	}

	return {
		content,
		status: response ? response.status() : null,
		headers,
		contentType: ct,
	};
};

app.get("/health", async (req: Request, res: Response) => {
	try {
		if (!browser) {
			await initializeBrowser();
		}

		const testContext = await createContext();
		const testPage = await testContext.newPage();
		await testPage.close();
		await testContext.close();

		res.status(200).json({
			status: "healthy",
			maxConcurrentPages: MAX_CONCURRENT_PAGES,
			activePages: MAX_CONCURRENT_PAGES - pageSemaphore.getAvailablePermits(),
			flareSolverrEnabled: ENABLE_CLOUDFLARE_BYPASS,
			cacheEnabled: CACHE_ENABLED,
		});
	} catch (error) {
		console.error("Health check failed:", error);
		res.status(503).json({
			status: "unhealthy",
			error: error instanceof Error ? error.message : "Unknown error occurred",
		});
	}
});

app.post("/scrape", async (req: Request, res: Response) => {
	const {
		url,
		wait_after_load = 0,
		timeout = 15000,
		headers,
		check_selector,
		skip_tls_verification = false,
		bypass_cloudflare = ENABLE_CLOUDFLARE_BYPASS,
		cookies,
		use_cache = CACHE_ENABLED,
		max_retries, // ✅ Added for per-request retry control
	}: UrlModel = req.body;

	console.log(`================= Scrape Request =================`);
	console.log(`URL: ${url}`);
	console.log(`Wait After Load: ${wait_after_load}`);
	console.log(`Timeout: ${timeout}`);
	console.log(`Headers: ${headers ? JSON.stringify(headers) : "None"}`);
	console.log(`Check Selector: ${check_selector ? check_selector : "None"}`);
	console.log(`Skip TLS Verification: ${skip_tls_verification}`);
	console.log(`Bypass Cloudflare: ${bypass_cloudflare}`);
	console.log(`Use Cache: ${use_cache}`);
	console.log(`==================================================`);

	if (!url || !isValidUrl(url)) {
		return res.status(400).json({ error: "Valid URL is required" });
	}

	// ✅ 1. Check Redis Cache
	const cacheKey = { bypass_cloudflare, headers, check_selector, wait_after_load };
	if (use_cache && cache.isEnabled()) {
		const cachedData = await cache.get(url, cacheKey);
		if (cachedData) {
			console.log(`[Cache] Serving cached content for: ${url}`);
			return res.json({ ...cachedData, cached: true });
		}
	}

	if (!PROXY_SERVER) {
		console.warn("⚠️ WARNING: No proxy server provided. Your IP address may be blocked.");
	}

	if (!browser) {
		await initializeBrowser();
	}

	await pageSemaphore.acquire();

	let requestContext: BrowserContext | null = null;
	let page: Page | null = null;
	let injectedCookies: any[] = cookies || [];
	let customUserAgent: string | undefined = undefined;

	try {
		if (bypass_cloudflare && flareSolverr && ENABLE_CLOUDFLARE_BYPASS) {
			console.log("[Playwright] 🔥 Attempting Cloudflare bypass with FlareSolverr...");

			const proxyUrl = PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD ? `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_SERVER}` : PROXY_SERVER;

			const flareResult = await flareSolverr.solveCloudflareChallengeWithProxy(url, proxyUrl || undefined);

			if (flareResult && flareResult.solution.cookies.length > 0) {
				const flareCookies = convertFlareSolverrCookies(flareResult.solution.cookies, url);
				injectedCookies = [...injectedCookies, ...flareCookies];
				customUserAgent = flareResult.solution.userAgent;
				console.log(`[Playwright] ✓ FlareSolverr success! Got ${flareCookies.length} cookies`);
			} else {
				console.log("[Playwright] ⚠ FlareSolverr failed, proceeding without bypass");
			}
		}

		requestContext = await createContext(skip_tls_verification, customUserAgent, injectedCookies);
		page = await requestContext.newPage();

		if (headers) {
			await page.setExtraHTTPHeaders(headers);
		}

		// ✅ 2. Execute scraping with Retry Logic
		const result = await retryHandler.execute(() => scrapePage(page!, url, "load", wait_after_load, timeout, check_selector), `Scrape: ${url}`);

		const pageError = result.status !== 200 ? getError(result.status) : undefined;

		const responseData = {
			content: result.content,
			pageStatusCode: result.status,
			contentType: result.contentType,
			cookiesUsed: injectedCookies.length,
			cached: false,
			...(pageError && { pageError }),
		};

		// ✅ 3. Save to Cache
		if (result.status === 200 && use_cache && cache.isEnabled()) {
			await cache.set(url, responseData, cacheKey);
		}

		if (!pageError) {
			console.log(`✅ Scrape successful!`);
		} else {
			console.log(`🚨 Scrape failed with status code: ${result.status} ${pageError}`);
		}

		res.json(responseData);
	} catch (error: any) {
		console.error("Scrape error after retries:", error.message);
		res.status(500).json({ error: error.message || "An error occurred while fetching the page." });
	} finally {
		if (page) await page.close();
		if (requestContext) await requestContext.close();
		pageSemaphore.release();
	}
});

app.listen(port, () => {
	initializeBrowser().then(() => {
		console.log(`Server is running on port ${port}`);
		console.log(`FlareSolverr Cloudflare bypass: ${ENABLE_CLOUDFLARE_BYPASS ? "✅ ENABLED" : "❌ DISABLED"}`);
	});
});

if (require.main === module) {
	process.on("SIGINT", () => {
		cache.close().then(() => {
			shutdownBrowser().then(() => {
				console.log("Browser and Cache connection closed");
				process.exit(0);
			});
		});
	});
}
