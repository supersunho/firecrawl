import Redis from "ioredis";
import { createHash } from "crypto";

export interface CacheOptions {
	ttl?: number;
}

export class ScraperCache {
	private redis: Redis;
	private enabled: boolean;
	private defaultTTL: number;

	constructor() {
		this.enabled = process.env.CACHE_ENABLED === "true";
		this.defaultTTL = parseInt(process.env.CACHE_TTL || "3600", 10);

		if (this.enabled) {
			// Use existing Redis service defined in docker-compose
			this.redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
				retryStrategy: times => Math.min(times * 50, 2000),
				maxRetriesPerRequest: 3,
			});

			this.redis.on("connect", () => console.log("[Cache] Connected to existing Redis"));
			this.redis.on("error", err => console.error("[Cache] Redis error:", err));
		}
	}

	private generateKey(url: string, options?: Record<string, any>): string {
		// Generate unique key for each URL and configuration combo
		const data = JSON.stringify({ url, options });
		const hash = createHash("sha256").update(data).digest("hex");
		return `scrape:${hash}`;
	}

	async get(url: string, options?: Record<string, any>): Promise<any | null> {
		if (!this.enabled) return null;
		try {
			const key = this.generateKey(url, options);
			const cached = await this.redis.get(key);
			if (cached) {
				console.log(`[Cache] HIT: ${url}`);
				return JSON.parse(cached);
			}
			return null;
		} catch (error) {
			console.error("[Cache] Get error:", error);
			return null;
		}
	}

	async set(url: string, data: any, options?: Record<string, any>, cacheOptions?: CacheOptions): Promise<void> {
		if (!this.enabled) return;
		try {
			const key = this.generateKey(url, options);
			const ttl = cacheOptions?.ttl || this.defaultTTL;
			await this.redis.setex(key, ttl, JSON.stringify(data));
			console.log(`[Cache] SET: ${url} (TTL: ${ttl}s)`);
		} catch (error) {
			console.error("[Cache] Set error:", error);
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	async close(): Promise<void> {
		if (this.enabled && this.redis) await this.redis.quit();
	}
}
