import { Page } from "playwright";
import { PNG } from "pngjs";

export interface DiffResult {
	changed: boolean;
	diffPercent: number;
	currentScreenshot: Buffer;
	diffImage?: Buffer;
}

export class VisualDiffDetector {
	/**
	 * Compare current page screenshot with a previous one
	 * @param page Playwright Page instance
	 * @param previousScreenshot Buffer of the previous PNG screenshot
	 * @param threshold Sensitivity threshold (0 to 1, smaller is more sensitive)
	 */
	async detectChange(page: Page, previousScreenshot?: Buffer, threshold: number = 0.1): Promise<DiffResult> {
		// ✅ Use dynamic import to support ESM-only pixelmatch in CommonJS environment
		// ✅ eval('import(...)') is used to prevent TypeScript from compiling it back to require()
		const { default: pixelmatch } = await (eval('import("pixelmatch")') as Promise<any>);

		// Capture full page screenshot
		const currentScreenshot = await page.screenshot({ fullPage: true });

		if (!previousScreenshot) {
			return {
				changed: false,
				diffPercent: 0,
				currentScreenshot,
			};
		}

		try {
			const img1 = PNG.sync.read(previousScreenshot);
			const img2 = PNG.sync.read(currentScreenshot);

			const { width, height } = img1;
			const diff = new PNG({ width, height });

			// Compare pixels using the dynamically loaded pixelmatch
			const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold });

			const diffPercent = (numDiffPixels / (width * height)) * 100;
			const changed = diffPercent > 0.05; // Consider changed if more than 0.05% pixels differ

			return {
				changed,
				diffPercent,
				currentScreenshot,
				diffImage: changed ? PNG.sync.write(diff) : undefined,
			};
		} catch (error: any) {
			console.error("[VisualDiff] Comparison error:", error.message);
			// If sizes mismatch or error occurs, treat as changed
			return {
				changed: true,
				diffPercent: 100,
				currentScreenshot,
			};
		}
	}
}
