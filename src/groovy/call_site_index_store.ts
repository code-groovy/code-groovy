import { CallSiteRecord } from './call_site_extractor';

export class CallSiteIndexStore {
	private readonly byMethodName = new Map<string, CallSiteRecord[]>();
	private readonly byReceiverName = new Map<string, CallSiteRecord[]>();
	private readonly filesByTypeMention = new Map<string, number[]>();
	private readonly filePaths: string[] = [];
	private readonly fileIds = new Map<string, number>();
	private ready = false;

	add(records: CallSiteRecord[]): void {
		for (const record of records) {
			const list = this.byMethodName.get(record.methodName) ?? [];
			list.push(record);
			this.byMethodName.set(record.methodName, list);

			if (record.receiverName) {
				const byReceiver = this.byReceiverName.get(record.receiverName) ?? [];
				byReceiver.push(record);
				this.byReceiverName.set(record.receiverName, byReceiver);
			}
		}
		this.ready = true;
	}

	addTypeMentions(sourcePath: string, typeNames: string[]): void {
		let fileId = this.fileIds.get(sourcePath);
		if (fileId === undefined) {
			fileId = this.filePaths.push(sourcePath) - 1;
			this.fileIds.set(sourcePath, fileId);
		}
		for (const typeName of typeNames) {
			const files = this.filesByTypeMention.get(typeName) ?? [];
			files.push(fileId);
			this.filesByTypeMention.set(typeName, files);
		}
	}

	clear(): void {
		this.byMethodName.clear();
		this.byReceiverName.clear();
		this.filesByTypeMention.clear();
		this.filePaths.length = 0;
		this.fileIds.clear();
	}

	removeFile(sourcePath: string, records: CallSiteRecord[], typeNames: string[]): void {
		const removed = new Set(records);
		const prune = (map: Map<string, CallSiteRecord[]>, key: string | undefined) => {
			const list = key === undefined ? undefined : map.get(key);
			if (!list || key === undefined) {
				return;
			}
			const kept = list.filter(record => !removed.has(record));
			if (kept.length === 0) {
				map.delete(key);
			} else if (kept.length !== list.length) {
				map.set(key, kept);
			}
		};
		for (const name of new Set(records.map(record => record.methodName))) {
			prune(this.byMethodName, name);
		}
		for (const name of new Set(records.map(record => record.receiverName))) {
			prune(this.byReceiverName, name);
		}
		const fileId = this.fileIds.get(sourcePath);
		if (fileId === undefined) {
			return;
		}
		for (const typeName of typeNames) {
			const files = this.filesByTypeMention.get(typeName)?.filter(id => id !== fileId);
			if (files && files.length > 0) {
				this.filesByTypeMention.set(typeName, files);
			} else {
				this.filesByTypeMention.delete(typeName);
			}
		}
	}

	lookup(methodName: string): CallSiteRecord[] {
		return this.byMethodName.get(methodName) ?? [];
	}

	lookupByReceiver(receiverName: string): CallSiteRecord[] {
		return this.byReceiverName.get(receiverName) ?? [];
	}

	filesMentioning(typeName: string): string[] {
		return (this.filesByTypeMention.get(typeName) ?? []).map(fileId => this.filePaths[fileId]);
	}

	isReady(): boolean {
		return this.ready;
	}
}
