import * as vscode from 'vscode';

const EXTENSION_NAME = "Custom Postfix Completion"
const DEFAULT_WORD_REGEX = /\w+/
const VARIABLE_REGEX = /^\$\{(\w+)(?:#(\d+))?(?::(\w+\(target\))?(?::(.+))?)?\}$/;
let extensionContext: vscode.ExtensionContext;
let isDebugMode = false;
let configuration: vscode.WorkspaceConfiguration;
let languagePostfixTemplatesMap: Map<string, LanguagePostfixTemplate>;
type LanguagePostfixTemplate = {
	triggerWord: string;
	description: string;
	targetRegExp: RegExp;
	body: string[];

	parsedBody: (string | TemplateVarible)[];
}
type TemplateVarible = {
	name: string;
	no?: number;
	// 表达式和参数，如果不是 undefined，首个元素是表达式（函数）
	expressionAndParam?: (((word: string) => string) | string)[];
	defaultValue?: string;
}

export function deactivate() { }
export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	// 初始化配置
	try {
		refreshConfigs();
	} catch (error) {
		debugLog(error);
		showErrorMessage('Fail to initialize, you can check console (in developer tools) to see more details');
	}

	// 注册命令
	let disposable = vscode.commands.registerCommand('custom-postfix-completion.refresh-configs', tryCommand(refreshConfigs));
	context.subscriptions.push(disposable);
	disposable = vscode.commands.registerCommand('custom-postfix-completion.apply-template', tryCommand(applyTemplate));
	context.subscriptions.push(disposable);

	// 配置变化时重新加载配置
	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('custom-postfix-completion')) {
			refreshConfigs();
		}
	});
}

function tryCommand(callback: (...args: any[]) => any): (...args: any[]) => any {
	return function () {
		try {
			callback();
		} catch (error) {
			console.log(error);
			showErrorMessage('Fail to execute command, you can check console (in developer tools) to see more details');
		}
	}
}
function debugLog(message?: any, ...optionalParams: any[]): void {
	if (isDebugMode) {
		console.log(message, ...optionalParams);
	}
}
function showErrorMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined> {
	return vscode.window.showErrorMessage(`${EXTENSION_NAME}: ` + message, ...items);
}

function getKey(language: string, triggerWord: string): string {
	return language + ':' + triggerWord;
}
function refreshConfigs() {
	configuration = vscode.workspace.getConfiguration('custom-postfix-completion');
	if (!configuration) {
		return;
	}
	if (extensionContext.extensionMode !== vscode.ExtensionMode.Production
		|| configuration.get<boolean>('debugMode')) {
		isDebugMode = true;
	} else {
		isDebugMode = false;
	}

	parseLanguagePostfixTemplates();
}
function parseLanguagePostfixTemplates() {
	let languageTemplatesRaw = configuration.get('languageTemplates')
	if (!languageTemplatesRaw) {
		return;
	}
	let languageTemplates = languageTemplatesRaw as { [key: string]: any }

	let newMap = new Map();
	const languageIds = Object.keys(languageTemplatesRaw);
	for (const languageId of languageIds) {
		let eachLangTemplate = languageTemplates[languageId] as { templates: LanguagePostfixTemplate[] | undefined; };
		if (!eachLangTemplate.templates) {
			continue;
		}
		for (const template of eachLangTemplate.templates) {
			const key = getKey(languageId, template.triggerWord);
			if (newMap.has(key)) {
				showErrorMessage(`Duplicate template: ${template.triggerWord}`);
				continue;
			}

			let validateMsg: string | undefined;
			if ((validateMsg = validateAndParseTemplate(template)) !== undefined) {
				showErrorMessage(`Invalid template: ${template.triggerWord}: ${validateMsg}`);
				continue;
			}

			if (template.targetRegExp) {
				template.targetRegExp = new RegExp(template.targetRegExp);
			} else {
				template.targetRegExp = DEFAULT_WORD_REGEX;
			}
			newMap.set(key, template);
		}
	}
	languagePostfixTemplatesMap = newMap;
	debugLog("languagePostfixTemplatesMap", JSON.stringify(Array.from(languagePostfixTemplatesMap.entries())));
}
/**
 * Validates and parses a template.
 *
 * @param {LanguagePostfixTemplate} template - The template to validate and parse.
 * @return {string | undefined} - Validation errors or undefined if the template is valid.
 */
function validateAndParseTemplate(template: LanguagePostfixTemplate): string | undefined {
	const parsedBody: (string | TemplateVarible)[] = [];
	const body = template.body.join('\n');
	const bodyParts = splitBody(body);
	for(const part of bodyParts) {
		if(!(part.startsWith('${') && part.endsWith('}'))) {
			parsedBody.push(part);
			continue;
		}

		const possibleVariable = part;
		const matches = VARIABLE_REGEX.exec(possibleVariable);
		VARIABLE_REGEX.lastIndex = 0;
		if (!matches) {
			return `Wrong format of variable: ${possibleVariable}`;
		}
		const [variable, name, no, expression, defaultValue] = matches;
		debugLog("variable", variable, "name", name, "no", no, "expression", expression, "defaultValue", defaultValue);

		// 不定义 NO 的变量跳过用户交互
		const skipUserInteraction = no === undefined;
		const isTarget = /^target$/i.test(name);
		// 跳过用户交互的变量必须是 target 变量，或者包含 EXPRESSION 或 DEFAULT_VALUE
		if (skipUserInteraction && !isTarget && !expression && !defaultValue) {
			return `NAME without #NO must include EXPRESSION or DEFAULT_VALUE: ${variable}`;
		}
		let expressionAndParam: (((word: string) => string) | string)[] | undefined;
		if (expression) {
			expressionAndParam = extractExpression(expression);
			if (!expressionAndParam) {
				return `Wrong format of expression: ${expression}`;
			}
			let expressionFunc = getExpressionFunc(expressionAndParam[0] as string);
			if (!expressionFunc) {
				return `Unsupported expression: ${expression}`;
			}
			expressionAndParam[0] = expressionFunc;
		}

		parsedBody.push({
			name,
			no: no ? Number(no) : undefined,
			expressionAndParam: expressionAndParam,
			defaultValue,
		} as TemplateVarible);
	}
	template.parsedBody = parsedBody;
	return undefined;
}
// 把 body 拆分为变量和非变量，按顺序添加到 results。
// 不用正则的原因是正则不太好处理 `${`、`}` 嵌套的情况。
function splitBody(body: string): string[] {
	const results: string[] = [];
	const stack: number[] = [];
	let lastMatchEndIndex = 0;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '$' && i + 1 < body.length && body[i + 1] === '{') {
			stack.push(i);
			i++;
		} else if (body[i] === '{') {
			if (stack.length > 0) {
				stack.push(i);
			}
		} else if (body[i] === '}') {
			if (stack.length > 0) {
				const lastOpeningIndex = stack.pop() as number;
				if (stack.length === 0) {
					if (lastMatchEndIndex < lastOpeningIndex) {
						results.push(body.substring(lastMatchEndIndex, lastOpeningIndex));
					}
					results.push(body.substring(lastOpeningIndex, i + 1));
					lastMatchEndIndex = i + 1;
				}
			}
		}
	}
	if (lastMatchEndIndex < body.length) {
		results.push(body.substring(lastMatchEndIndex));
	}
	return results;
}

function applyTemplate() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	// 获取触发词范围
	const cursorPosition = editor.selection.end;
	const triggerWordRange = editor.document.getWordRangeAtPosition(cursorPosition, DEFAULT_WORD_REGEX);
	debugLog("triggerWordRange", triggerWordRange);
	if (!triggerWordRange) {
		return;
	}
	// 检查触发词前面是否 . 字符
	let dotPosition = triggerWordRange.start.translate(0, -1);
	debugLog("dotPosition", dotPosition);
	let dotStr = editor.document.getText(new vscode.Range(dotPosition, dotPosition.translate(0, 1)));
	if (!dotStr || dotStr !== '.') {
		return
	}

	// 检查模板配置是否包含此触发词
	const triggerWord = editor.document.getText(triggerWordRange);
	const key = getKey(editor.document.languageId, triggerWord);
	let template = languagePostfixTemplatesMap.get(key)
	if (!template) {
		return;
	}

	// 获取模板应用于的表达式（也就是.前面的那部分）
	const targetRange = editor.document.getWordRangeAtPosition(dotPosition/* .translate(0, -1) */, template.targetRegExp);
	debugLog("targetRange", targetRange);
	if (!targetRange) {
		return;
	}
	let targetWord = editor.document.getText(targetRange);
	debugLog("triggerWord", triggerWord, "targetWord", targetWord);
	if (!triggerWord || !targetWord) {
		return;
	}
	if (targetWord.endsWith('.' + triggerWord)) {
		targetWord = targetWord.substring(0, targetWord.length - triggerWord.length - 1)
	}
	debugLog("triggerWord", triggerWord, "targetWord", targetWord);

	const snippet = templateToSnippet(template, targetWord);
	if (snippet) {
		let replaceRange = new vscode.Range(targetRange.start, triggerWordRange.end);
		editor.insertSnippet(snippet, replaceRange);
	}
}
function templateToSnippet(template: LanguagePostfixTemplate, targetWord: string): vscode.SnippetString | undefined {
	const snippet = new vscode.SnippetString();
	for (const part of template.parsedBody) {
		if (typeof part === 'string') {
			snippet.appendText(part);
			continue;
		}

		let variable = part as TemplateVarible;
		const skipUserInteraction = variable.no === undefined;
		const isTarget = /^target$/i.test(variable.name);
		const value = isTarget ? targetWord : evalExpression(variable.expressionAndParam, targetWord) || variable.defaultValue || '';
		if (skipUserInteraction) {
			snippet.appendText(value);
		} else {
			snippet.appendPlaceholder(value, variable.no);
		}
	}

	debugLog("snippet", snippet);
	return snippet;
}
function extractExpression(expression: string): string[] | undefined {
	let match = /^(\w+)\((.*)\)$/.exec(expression);
	return match ? [match[1], match[2]] : undefined;
}
function getExpressionFunc(expressionName: string): undefined | ((target: string) => string) {
	switch (expressionName) {
		case "escapeString": {
			return expressionEscapeString;
		}
		default: {
			return undefined;
		}
	}
}
function evalExpression(expressionAndParam: (((word: string) => string) | string)[] | undefined, targetWord: string): string | undefined {
	if (!expressionAndParam) {
		return undefined;
	}
	return (expressionAndParam[0] as ((target: string) => string))(targetWord);
}
function expressionEscapeString(targetWord: string): string {
	return targetWord.replaceAll('"', '\\"');
}