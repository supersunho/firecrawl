// Utility for visual regression testing and change detection using pixelmatch
import { Page } from "playwright";
import pixelmatch from "pixelmatch";
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

			// Compare pixels
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
