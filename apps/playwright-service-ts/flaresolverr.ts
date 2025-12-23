// apps/playwright-service-ts/src/flaresolverr.ts

import axios from "axios";

export interface FlareSolverrCookie {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
}

export interface FlareSolverrResponse {
	solution: {
		url: string;
		status: number;
		cookies: FlareSolverrCookie[];
		userAgent: string;
		response: string;
	};
	status: string;
	message: string;
	startTimestamp: number;
	endTimestamp: number;
	version: string;
}

export class FlareSolverrClient {
	private baseUrl: string;
	private timeout: number;

	constructor(baseUrl?: string, timeout: number = 60000) {
		this.baseUrl = baseUrl || process.env.FLARESOLVERR_URL || "http://localhost:8191";
		this.timeout = timeout;
	}

	async solveCloudflareChallengeWithProxy(url: string, proxy?: string, sessionId?: string): Promise<FlareSolverrResponse | null> {
		try {
			console.log(`[FlareSolverr] Solving Cloudflare challenge for: ${url}`);

			const payload: any = {
				cmd: "request.get",
				url: url,
				maxTimeout: this.timeout,
			};

			if (sessionId) {
				payload.session = sessionId;
			}

			if (proxy) {
				payload.proxy = { url: proxy };
			}

			const response = await axios.post(`${this.baseUrl}/v1`, payload, {
				timeout: this.timeout + 5000,
				headers: { "Content-Type": "application/json" },
			});

			if (response.data.status === "ok") {
				console.log(`[FlareSolverr] ✓ Successfully bypassed Cloudflare for: ${url}`);
				return response.data;
			} else {
				console.error(`[FlareSolverr] ✗ Failed:`, response.data.message);
				return null;
			}
		} catch (error: any) {
			console.error(`[FlareSolverr] Error:`, error.message);
			return null;
		}
	}

	async createSession(sessionId: string): Promise<boolean> {
		try {
			const response = await axios.post(`${this.baseUrl}/v1`, {
				cmd: "sessions.create",
				session: sessionId,
			});
			return response.data.status === "ok";
		} catch (error) {
			console.error(`[FlareSolverr] Failed to create session:`, error);
			return false;
		}
	}

	async destroySession(sessionId: string): Promise<boolean> {
		try {
			const response = await axios.post(`${this.baseUrl}/v1`, {
				cmd: "sessions.destroy",
				session: sessionId,
			});
			return response.data.status === "ok";
		} catch (error) {
			console.error(`[FlareSolverr] Failed to destroy session:`, error);
			return false;
		}
	}
}