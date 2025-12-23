// Retry utility for wrapping async operations with exponential backoff

export interface RetryOptions {
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

export type RetryableFn<T> = () => Promise<T>;

export class RetryHandler {
	private maxRetries: number;
	private baseDelayMs: number;
	private maxDelayMs: number;

	constructor(options?: RetryOptions) {
		this.maxRetries = options?.maxRetries ?? parseInt(process.env.RETRY_MAX_RETRIES || "3", 10);
		this.baseDelayMs = options?.baseDelayMs ?? parseInt(process.env.RETRY_BASE_DELAY_MS || "1000", 10);
		this.maxDelayMs = options?.maxDelayMs ?? parseInt(process.env.RETRY_MAX_DELAY_MS || "10000", 10);
	}

	private async delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private calculateDelay(attempt: number): number {
		// Use exponential backoff with jitter
		const expDelay = this.baseDelayMs * Math.pow(2, attempt);
		const jitter = Math.random() * this.baseDelayMs;
		const totalDelay = expDelay + jitter;
		return Math.min(totalDelay, this.maxDelayMs);
	}

	private isRetryableStatus(status?: number | null): boolean {
		if (!status) return true;
		if (status === 429) return true;
		if (status >= 500 && status < 600) return true;
		return false;
	}

	async execute<T>(fn: RetryableFn<T>, context?: string): Promise<T> {
		let lastError: any;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				if (attempt > 0) {
					console.log(`[Retry] Attempt ${attempt + 1}/${this.maxRetries + 1}${context ? ` (${context})` : ""}`);
				}
				const result = await fn();
				return result;
			} catch (error: any) {
				lastError = error;

				const status = error?.status ?? error?.response?.status;
				const shouldRetry = this.isRetryableStatus(status);

				if (!shouldRetry || attempt === this.maxRetries) {
					console.error(`[Retry] Giving up after ${attempt + 1} attempts${context ? ` (${context})` : ""}. Last error:`, error?.message || error);
					throw error;
				}

				const delayMs = this.calculateDelay(attempt);
				console.warn(`[Retry] Error occurred${context ? ` in ${context}` : ""} (status=${status ?? "unknown"}). ` + `Retrying in ${Math.round(delayMs)}ms...`);
				await this.delay(delayMs);
			}
		}

		throw lastError;
	}
}
