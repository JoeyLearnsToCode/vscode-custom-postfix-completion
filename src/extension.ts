import * as vscode from 'vscode';

const EXTENSION_NAME = "Custom Postfix Completion"
const DEFAULT_WORD_REGEX = /\w+/
const POSSIBLE_VARIABLE_REGEX = /\$\{[^\}]*\}/g;
const VARIABLE_REGEX = /\$\{(\w+)(?:#(\d+))?(?::(\w+\(expr\))?(?::([^\}]+))?)?\}/g;
let extensionContext: vscode.ExtensionContext;
let isDebugMode = false;
let configuration: vscode.WorkspaceConfiguration;
let languagePostfixTemplatesMap: Map<string, LanguagePostfixTemplate>;
type LanguagePostfixTemplate = {
	triggerWord: string;
	description: string;
	exprRegExp: RegExp;
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

			if (template.exprRegExp) {
				template.exprRegExp = new RegExp(template.exprRegExp);
			} else {
				template.exprRegExp = DEFAULT_WORD_REGEX;
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
	let lastIndex = 0;
	let parsedBody: (string | TemplateVarible)[] = [];
	let matches: RegExpExecArray | null;

	const body = template.body.join('\n');
	while ((matches = POSSIBLE_VARIABLE_REGEX.exec(body)) !== null) {
		if (matches.index > lastIndex) {
			parsedBody.push(body.substring(lastIndex, matches.index));
		}
		lastIndex = matches.index + matches[0].length;

		const possibleVariable = matches[0];
		matches = VARIABLE_REGEX.exec(possibleVariable);
		VARIABLE_REGEX.lastIndex = 0;
		if (!matches) {
			return `Wrong format of variable: ${possibleVariable}`;
		}

		const [variable, name, no, expression, defaultValue] = matches;
		debugLog("variable", variable, "name", name, "no", no, "expression", expression, "defaultValue", defaultValue);

		// 不定义 NO 的变量跳过用户交互
		const skipUserInteraction = no === undefined;
		const isExpr = /^expr$/i.test(name);
		// 跳过用户交互的变量必须是 expr 变量，或者包含 EXPRESSION 或 DEFAULT_VALUE
		if (skipUserInteraction && !isExpr && !expression && !defaultValue) {
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
	POSSIBLE_VARIABLE_REGEX.lastIndex = 0;
	if (lastIndex < body.length) {
		parsedBody.push(body.substring(lastIndex));
	}
	template.parsedBody = parsedBody;
	return undefined;
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
	const exprRange = editor.document.getWordRangeAtPosition(dotPosition/* .translate(0, -1) */, template.exprRegExp);
	debugLog("exprRange", exprRange);
	if (!exprRange) {
		return;
	}
	let exprWord = editor.document.getText(exprRange);
	debugLog("triggerWord", triggerWord, "exprWord", exprWord);
	if (!triggerWord || !exprWord) {
		return;
	}
	if (exprWord.endsWith('.' + triggerWord)) {
		exprWord = exprWord.substring(0, exprWord.length - triggerWord.length - 1)
	}
	debugLog("triggerWord", triggerWord, "exprWord", exprWord);

	const snippet = templateToSnippet(template, exprWord);
	if (snippet) {
		let replaceRange = new vscode.Range(exprRange.start, triggerWordRange.end);
		editor.insertSnippet(snippet, replaceRange);
	}
}
function templateToSnippet(template: LanguagePostfixTemplate, exprWord: string): vscode.SnippetString | undefined {
	const snippet = new vscode.SnippetString();
	for (const part of template.parsedBody) {
		if (typeof part === 'string') {
			snippet.appendText(part);
			continue;
		}

		let variable = part as TemplateVarible;
		const skipUserInteraction = variable.no === undefined;
		const isExpr = /^expr$/i.test(variable.name);
		const value = isExpr ? exprWord : evalExpression(variable.expressionAndParam, exprWord) || variable.defaultValue || '';
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
function getExpressionFunc(expressionName: string): undefined | ((expr: string) => string) {
	switch (expressionName) {
		case "escapeString": {
			return expressionEscapeString;
		}
		default: {
			return undefined;
		}
	}
}
function evalExpression(expressionAndParam: (((word: string) => string) | string)[] | undefined, exprWord: string): string | undefined {
	if (!expressionAndParam) {
		return undefined;
	}
	return (expressionAndParam[0] as ((expr: string) => string))(exprWord);
}
function expressionEscapeString(exprWord: string): string {
	return exprWord.replaceAll('"', '\\"');
}