import * as vscode from 'vscode';

export function deactivate() { }
export function activate(context: vscode.ExtensionContext) {
	// 初始计划配置
	try {
		refreshConfigs();
	} catch (error) {
		console.log(error);
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

const DEFAULT_WORD_REGEX = /\w+/
const EXTENSION_NAME = "Custom Postfix Completion"
let configuration: vscode.WorkspaceConfiguration;
let languagePostfixTemplatesMap: Map<string, LanguagePostfixTemplate>;
type LanguagePostfixTemplate = {
	triggerWord: string;
	description: string;
	exprRegExp: RegExp;
	body: string[];
}

function refreshConfigs() {
	configuration = vscode.workspace.getConfiguration('custom-postfix-completion');
	if (!configuration) {
		return;
	}
	let languageTemplatesRaw = configuration.get('languageTemplates')
	if (!languageTemplatesRaw) {
		return;
	}
	let languageTemplates = languageTemplatesRaw as { [key: string]: any }
	const languageIds = Object.keys(languageTemplatesRaw);

	let newMap = new Map();
	languageIds.forEach((languageId) => {
		let eachLangTemplate = languageTemplates[languageId] as { templates: LanguagePostfixTemplate[] | undefined; };
		if (!eachLangTemplate.templates) {
			return
		}
		eachLangTemplate.templates.forEach((template) => {
			const key = getKey(languageId, template.triggerWord);
			if (newMap.has(key)) {
				showErrorMessage(`Duplicate triggerWord: ${template.triggerWord}`);
				return
			}

			if (template.exprRegExp) {
				console.log("exprRegExp", template.exprRegExp);
				template.exprRegExp = new RegExp(template.exprRegExp);
			} else {
				template.exprRegExp = DEFAULT_WORD_REGEX
			}
			newMap.set(key, template);
		})
	});
	languagePostfixTemplatesMap = newMap;
	console.log("languagePostfixTemplatesMap", JSON.stringify(Array.from(languagePostfixTemplatesMap.entries())));
}

function showErrorMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined> {
	return vscode.window.showErrorMessage(`${EXTENSION_NAME}: ` + message, ...items);
}

function getKey(language: string, triggerWord: string): string {
	return language + ':' + triggerWord;
}

function applyTemplate() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	// 获取触发词范围
	const cursorPosition = editor.selection.end;
	const triggerWordRange = editor.document.getWordRangeAtPosition(cursorPosition, DEFAULT_WORD_REGEX);
	console.log("triggerWordRange", triggerWordRange);
	if (!triggerWordRange) {
		return;
	}
	// 检查触发词前面是否 . 字符
	let dotPosition = triggerWordRange.start.translate(0, -1);
	console.log("dotPosition", dotPosition);
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
	console.log("exprRange", exprRange);
	if (!exprRange) {
		return;
	}
	let exprWord = editor.document.getText(exprRange);
	console.log("triggerWord", triggerWord, "exprWord", exprWord);
	if (!triggerWord || !exprWord) {
		return;
	}
	if (exprWord.endsWith('.' + triggerWord)) {
		exprWord = exprWord.substring(0, exprWord.length - triggerWord.length - 1)
	}
	console.log("triggerWord", triggerWord, "exprWord", exprWord);

	const snippet = templateToSnippet(exprWord, template);
	if (snippet) {
		let replaceRange = new vscode.Range(exprRange.start, triggerWordRange.end);
		editor.insertSnippet(snippet, replaceRange);
	}
}

function templateToSnippet(exprWord: string, template: LanguagePostfixTemplate): vscode.SnippetString | undefined {
	let body = template.body.join('\n');
	if (body === '') {
		return new vscode.SnippetString(body);
	}

	let snippet = transformToSnippetFormat(body, exprWord);
	if (!snippet) {
		return undefined;
	}
	console.log("snippet", snippet);
	return new vscode.SnippetString(snippet);
}

function transformToSnippetFormat(body: string, exprWord: string): string | undefined {
	const variablePattern = /\$\{(\w+)(?:#(\d+))?:?(\w+\(expr\))?:?([^\}]+)?\}/g;
	let validationErrors: string[] = [];
	let transformedBody = body;
	let matches: RegExpExecArray | null;

	while ((matches = variablePattern.exec(body)) !== null) {
		const [variable, name, no, expression, defaultValue] = matches;
		console.log("variable", variable, "name", name, "no", no, "expression", expression, "defaultValue", defaultValue);

		// Validate NAME
		if (!/^(\w+)$/.test(name)) {
			validationErrors.push(`Invalid NAME in variable: ${variable}`);
		}
		// Validate #NO
		if (no !== undefined && !/^\d+$/.test(no)) {
			validationErrors.push(`Invalid #NO in variable: ${variable}`);
		}
		// Validate EXPRESSION
		if (expression !== undefined && !/^\w+\(expr\)$/.test(expression)) {
			validationErrors.push(`Invalid EXPRESSION in variable: ${variable}`);
		}

		// 不定义 NO 的变量跳过用户交互
		const isSkipUserInteraction = no === undefined;
		const isExpr = /^expr$/i.test(name);
		// 跳过用户交互的变量必须包含 EXPRESSION 或 DEFAULT_VALUE，除非是 expr 变量
		if (isSkipUserInteraction && !isExpr && !expression && !defaultValue) {
			validationErrors.push(`NAME without #NO must include EXPRESSION or DEFAULT_VALUE: ${variable}`);
		}

		if (validationErrors.length === 0) {
			// Transform the variable
			let newValue = isExpr ? exprWord : evalExpression(expression, exprWord) || defaultValue || '';
			if (isSkipUserInteraction) {
				// Replace with EXPRESSION or DEFAULT_VALUE
				transformedBody = transformedBody.replace(variable, newValue);
			} else {
				// Replace with placeholder format
				transformedBody = transformedBody.replace(variable, `\${${no}:${newValue}}`);
			}
		} else {
			// Output validation errors and return undefined
			console.error('Validation errors:', validationErrors.join('; '));
			return undefined;
		}
	}

	return transformedBody;
}

function evalExpression(expression: string | undefined, exprWord: string): string | undefined {
	if (expression) {
		let expressionName = expression.substring(0, expression.indexOf('('));
		switch (expressionName) {
			case "escapeString": {
				return expressionEscapeString(exprWord);
			}
			default: {
				showErrorMessage("Unsupported expression: " + expressionName);
				return expression;
			}
		}
	}
}

function expressionEscapeString(exprWord: string): string {
	return exprWord.replaceAll('"', '\\"');
}