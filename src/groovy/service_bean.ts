export function classNameForBean(beanName: string): string {
	return /^[A-Z]/.test(beanName) ? beanName : beanName.charAt(0).toUpperCase() + beanName.slice(1);
}

export function grailsFieldNameForClass(className: string): string {
	if (className.length > 1 && isUpperCase(className.charAt(0)) && isUpperCase(className.charAt(1))) {
		return className;
	}
	return className.charAt(0).toLowerCase() + className.slice(1);
}

export function serviceBeanToClassName(beanName: string): string | undefined {
	if (!/^[a-z]\w*Service$/.test(beanName)) {
		return undefined;
	}
	return classNameForBean(beanName);
}

export function candidateClassNamesForReceiver(receiver: string): string[] {
	const names: string[] = [];
	const asService = serviceBeanToClassName(receiver);
	if (asService) {
		names.push(asService);
	}
	if (/^[A-Za-z_]\w*$/.test(receiver)) {
		names.push(classNameForBean(receiver));
	}
	return [...new Set(names)];
}

function isUpperCase(char: string): boolean {
	return char !== char.toLowerCase() && char === char.toUpperCase();
}
