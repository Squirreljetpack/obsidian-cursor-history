import { MarkdownPostProcessorContext, MarkdownView, setIcon, TFile } from 'obsidian';
import type CursorHistoryPlugin from './main';

export interface CodeFoldHistoryData {
	fold_all: boolean;
	remember_fold_state: boolean;
	files: Record<string, string[]>; // filePath -> block signatures
}

const DEFAULT_FOLD_HISTORY: CodeFoldHistoryData = {
	fold_all: false,
	remember_fold_state: true,
	files: {},
};

export class CodeFoldManager {
	private plugin: CursorHistoryPlugin;
	private data: CodeFoldHistoryData = { ...DEFAULT_FOLD_HISTORY };

	constructor(plugin: CursorHistoryPlugin) {
		this.plugin = plugin;
	}

	private get historyPath(): string {
		return `${this.plugin.app.vault.configDir}/cursor-history/code-fold.json`;
	}

	async init(): Promise<void> {
		await this.loadHistory();

		// 1. Register Markdown Post-Processor for Reading mode
		this.plugin.registerMarkdownPostProcessor((element, context) => {
			this.processReadingModeCodeBlocks(element, context);
		});

		// 2. Register file-open listener to validate and prune missing blocks
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', async (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					await this.validateAndPruneFile(file);
				}
			})
		);
	}

	// --- Persistence ---

	private async ensureDirectoryExists(): Promise<void> {
		const dir = `${this.plugin.app.vault.configDir}/cursor-history`;
		if (!(await this.plugin.app.vault.adapter.exists(dir))) {
			await this.plugin.app.vault.adapter.mkdir(dir);
		}
	}

	async loadHistory(): Promise<void> {
		try {
			const adapter = this.plugin.app.vault.adapter;
			if (await adapter.exists(this.historyPath)) {
				const content = await adapter.read(this.historyPath);
				this.data = { ...DEFAULT_FOLD_HISTORY, ...JSON.parse(content) };
			}
		} catch (e) {
			console.error('CodeFoldManager: Error loading code-fold.json:', e);
			this.data = { ...DEFAULT_FOLD_HISTORY };
		}
	}

	async saveHistory(): Promise<void> {
		try {
			await this.ensureDirectoryExists();
			await this.plugin.app.vault.adapter.write(
				this.historyPath,
				JSON.stringify(this.data, null, 2)
			);
		} catch (e) {
			console.error('CodeFoldManager: Error saving code-fold.json:', e);
		}
	}

	getFoldAll(): boolean {
		return this.data.fold_all;
	}

	async setFoldAll(foldAll: boolean): Promise<void> {
		if (this.data.fold_all === foldAll) return;
		this.data.fold_all = foldAll;
		this.data.files = {};
		await this.saveHistory();
		this.plugin.app.workspace.trigger('css-change');
	}

	getRememberFoldState(): boolean {
		return this.data.remember_fold_state ?? true;
	}

	async setRememberFoldState(remember: boolean): Promise<void> {
		if (this.data.remember_fold_state === remember) return;
		this.data.remember_fold_state = remember;
		await this.saveHistory();
		this.plugin.app.workspace.trigger('css-change');
	}

	async clearFileFoldHistory(filePath: string): Promise<void> {
		if (this.data.files[filePath]) {
			delete this.data.files[filePath];
			await this.saveHistory();
			this.plugin.app.workspace.trigger('css-change');
		}
	}

	async toggleFoldAllCurrentFile(): Promise<void> {
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) return;

		const filePath = view.file.path;
		const containerEl = view.contentEl.querySelector('.markdown-preview-view');
		if (!containerEl) return;

		const preElements = Array.from(containerEl.querySelectorAll<HTMLPreElement>('pre'));
		if (preElements.length === 0) return;

		const allFolded = preElements.every((pre) => pre.classList.contains('is-collapsed'));
		const targetFolded = !allFolded;

		const counts: Record<string, number> = {};
		const allBlockIds: string[] = [];

		preElements.forEach((pre) => {
			const codeEl = pre.querySelector('code');
			const codeText = (codeEl ? codeEl.textContent : pre.textContent) || '';

			const baseHash = this.hashText(codeText.trim());
			const idx = counts[baseHash] || 0;
			counts[baseHash] = idx + 1;
			const blockId = `h:${baseHash}-${idx}`;
			allBlockIds.push(blockId);

			if (targetFolded) {
				pre.classList.add('is-collapsed');
			} else {
				pre.classList.remove('is-collapsed');
			}

			this.ensureFoldButton(pre, filePath, blockId);
			const foldBtn = pre.querySelector<HTMLButtonElement>('.code-fold-btn');
			if (foldBtn) {
				setIcon(foldBtn, targetFolded ? 'chevron-right' : 'chevron-down');
			}
		});

		if (this.getRememberFoldState()) {
			const foldAll = this.data.fold_all;
			const shouldBeInStoredList = foldAll ? !targetFolded : targetFolded;

			if (shouldBeInStoredList) {
				this.data.files[filePath] = allBlockIds;
			} else {
				delete this.data.files[filePath];
			}
			await this.saveHistory();
		}
	}

	// --- Identification ---

	private hashText(text: string): string {
		let hash = 0;
		for (let i = 0; i < text.length; i++) {
			hash = (hash << 5) - hash + text.charCodeAt(i);
			hash |= 0;
		}
		return Math.abs(hash).toString(36);
	}

	private getSignaturesFromContents(contents: string[]): string[] {
		const counts: Record<string, number> = {};
		return contents.map((codeText) => {
			const baseHash = this.hashText(codeText.trim());
			const idx = counts[baseHash] || 0;
			counts[baseHash] = idx + 1;
			return `h:${baseHash}-${idx}`;
		});
	}

	// --- Reading Mode Processing ---

	private processReadingModeCodeBlocks(element: HTMLElement, context: MarkdownPostProcessorContext): void {
		const preElements = Array.from(element.querySelectorAll<HTMLPreElement>('pre'));
		if (preElements.length === 0) return;

		const filePath = context.sourcePath;
		const storedBlocks = this.getRememberFoldState()
			? (this.data.files[filePath] || [])
			: [];
		const counts: Record<string, number> = {};

		preElements.forEach((pre) => {
			const codeEl = pre.querySelector('code');
			const codeText = (codeEl ? codeEl.textContent : pre.textContent) || '';

			const baseHash = this.hashText(codeText.trim());
			const idx = counts[baseHash] || 0;
			counts[baseHash] = idx + 1;
			const blockId = `h:${baseHash}-${idx}`;

			const isInStoredList = storedBlocks.includes(blockId);
			const shouldBeFolded = this.data.fold_all ? !isInStoredList : isInStoredList;

			if (shouldBeFolded) {
				pre.classList.add('is-collapsed');
			} else {
				pre.classList.remove('is-collapsed');
			}

			this.ensureFoldButton(pre, filePath, blockId);
		});
	}

	private ensureFoldButton(pre: HTMLPreElement, filePath: string, blockId: string): void {
		if (pre.querySelector('.code-fold-btn')) return;

		pre.style.position = 'relative';

		const foldBtn = document.createElement('button');
		foldBtn.className = 'code-fold-btn';
		foldBtn.setAttribute('aria-label', 'Toggle code fold');
		
		const isCollapsed = pre.classList.contains('is-collapsed');
		setIcon(foldBtn, isCollapsed ? 'chevron-right' : 'chevron-down');

		foldBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const isNowCollapsed = pre.classList.toggle('is-collapsed');
			setIcon(foldBtn, isNowCollapsed ? 'chevron-right' : 'chevron-down');
			this.updateBlockFoldState(filePath, blockId, isNowCollapsed);
		});

		// Place next to existing copy button if present, otherwise append to pre
		const copyBtn = pre.querySelector('.copy-code-button');
		if (copyBtn && copyBtn.parentElement) {
			copyBtn.parentElement.insertBefore(foldBtn, copyBtn);
		} else {
			pre.appendChild(foldBtn);
		}
	}

	private updateBlockFoldState(filePath: string, blockId: string, isFolded: boolean): void {
		if (!this.getRememberFoldState()) return;
		if (!this.data.files[filePath]) {
			this.data.files[filePath] = [];
		}

		const list = this.data.files[filePath];
		const shouldStoreInList = this.data.fold_all ? !isFolded : isFolded;

		const index = list.indexOf(blockId);
		if (shouldStoreInList && index === -1) {
			list.push(blockId);
		} else if (!shouldStoreInList && index !== -1) {
			list.splice(index, 1);
		}

		if (list.length === 0) {
			delete this.data.files[filePath];
		}

		void this.saveHistory();
	}

	// --- Validation & Pruning ---

	async validateAndPruneFile(file: TFile): Promise<void> {
		const filePath = file.path;
		const storedBlocks = this.data.files[filePath];
		if (!storedBlocks || storedBlocks.length === 0) return;

		try {
			const content = await this.plugin.app.vault.cachedRead(file);
			const codeBlockRegex = /```[\s\S]*?\n([\s\S]*?)```/g;
			const currentContents: string[] = [];
			let match: RegExpExecArray | null;

			while ((match = codeBlockRegex.exec(content)) !== null) {
				currentContents.push(match[1]);
			}

			const validSignatures = new Set(this.getSignaturesFromContents(currentContents));
			const prunedBlocks = storedBlocks.filter((sig) => validSignatures.has(sig));

			if (prunedBlocks.length !== storedBlocks.length) {
				if (prunedBlocks.length > 0) {
					this.data.files[filePath] = prunedBlocks;
				} else {
					delete this.data.files[filePath];
				}
				await this.saveHistory();
			}
		} catch (e) {
			console.error(`CodeFoldManager: Error validating file ${filePath}:`, e);
		}
	}
}
