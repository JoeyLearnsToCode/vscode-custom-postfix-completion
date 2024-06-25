import * as vscode from 'vscode';

const EXTENSION_NAME = "Custom Postfix Completion"
const COMMAND_APPLY_TEMPLATE = 'custom-postfix-completion.apply-template';
const DEFAULT_WORD_REGEX = /\w+/
const VARIABLE_REGEX = /^\$\{(\w+)(?:#(\d+))?(?::(\w+\(target\))?(?::(.+))?)?\}$/;
let extensionContext: vscode.ExtensionContext;
let isDebugMode = false;
let configuration: vscode.WorkspaceConfiguration;
let languagePostfixTemplatesMap: Map<string, Map<string, LanguagePostfixTemplate>>;
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
		console.log(error);
		showErrorMessage('Fail to initialize, you can check console (in developer tools) to see more details');
	}

	// 注册命令
	let disposable = vscode.commands.registerCommand(COMMAND_APPLY_TEMPLATE, tryCommand(applyTemplate));
	context.subscriptions.push(disposable);

	// 配置变化时重新加载配置
	disposable = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
		if (e.affectsConfiguration('custom-postfix-completion')) {
			refreshConfigs();
		}
	});
	context.subscriptions.push(disposable);
}

function tryCommand(callback: (...args: any[]) => any): (...args: any[]) => any {
	return function (...args: any[]) {
		try {
			callback(...args);
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
	registerPostfixCompletionProvider();
}
function parseLanguagePostfixTemplates() {
	let languageTemplatesRaw = configuration.get('languageTemplates')
	if (!languageTemplatesRaw) {
		return;
	}
	let languageTemplates = languageTemplatesRaw as { [key: string]: any }

	let newMap: Map<string, Map<string, LanguagePostfixTemplate>> = new Map();
	const languageIds = Object.keys(languageTemplatesRaw);
	for (const languageId of languageIds) {
		let eachLangTemplate = languageTemplates[languageId] as { templates: LanguagePostfixTemplate[] | undefined; };
		if (!eachLangTemplate.templates) {
			continue;
		}
		let eachLangMap: Map<string, LanguagePostfixTemplate> = new Map();
		for (const template of eachLangTemplate.templates) {
			if (eachLangMap.has(template.triggerWord)) {
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
			template.targetRegExp = new RegExp(template.targetRegExp.source.endsWith('$') ? template.targetRegExp.source : template.targetRegExp.source + '$');
			eachLangMap.set(template.triggerWord, template);
		}
		newMap.set(languageId, eachLangMap);
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
	for (const part of bodyParts) {
		if (!(part.startsWith('${') && part.endsWith('}'))) {
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
let postfixCompletionProviderDisposable: vscode.Disposable;
function registerPostfixCompletionProvider() {
	let index = -1;
	if (postfixCompletionProviderDisposable) {
		postfixCompletionProviderDisposable.dispose();
		index = extensionContext.subscriptions.indexOf(postfixCompletionProviderDisposable);
	}

	const selector = Array.from(languagePostfixTemplatesMap.keys()).map(languageId => {
		return {
			language: languageId
		}
	});
	postfixCompletionProviderDisposable = vscode.languages.registerCompletionItemProvider(selector, new PostfixCompletionItemProvider(), '.');
	if (index > -1) {
		extensionContext.subscriptions.splice(index, 1, postfixCompletionProviderDisposable);
	} else {
		extensionContext.subscriptions.push(postfixCompletionProviderDisposable);
	}
}

class PostfixCompletionItemProvider implements vscode.CompletionItemProvider<vscode.CompletionItem> {
	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {

		// 补全建议要求：光标前是 `.` 或者光标前的触发词前面是 `.`。其他情况不提供建议。
		const lineText = document.lineAt(position.line).text;
		let endsWithDot = lineText.substring(0, position.character).endsWith('.');
		if (!endsWithDot) {
			const triggerWordRange = document.getWordRangeAtPosition(position, DEFAULT_WORD_REGEX);
			if (triggerWordRange && triggerWordRange.start.character > 0) {
				if (lineText[triggerWordRange.start.character - 1] !== '.') {
					return [];
				}
			}
		}

		const eachLangMap = languagePostfixTemplatesMap.get(document.languageId);
		if (!eachLangMap) {
			return;
		}
		let triggerWords = Array.from(eachLangMap.keys());
		let results = triggerWords.map(triggerWord => {
			const item = new vscode.CompletionItem({
				label: triggerWord,
				detail: "$",
				description: eachLangMap?.get(triggerWord)?.description,
			});
			item.insertText = triggerWord;
			item.sortText = EXTENSION_NAME;
			item.preselect = true;
			item.command = {
				title: 'Custom Postfix Completion: apply template',
				command: COMMAND_APPLY_TEMPLATE,
				arguments: [triggerWord]
			};
			return item;
		})
		return results;
	}
}

function applyTemplate(...args: any[]) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	// 触发词必须，要么从命令参数传入（补全建议被接受时），要么从编辑器光标前解析出来
	let triggerWord = args && args.length > 0 ? args[0] as string : undefined;
	let triggerWordRange = editor.document.getWordRangeAtPosition(editor.selection.end, DEFAULT_WORD_REGEX);
	debugLog("triggerWordRange", triggerWordRange);
	if (triggerWord) {
		if (triggerWordRange) {
			// do nothing
		} else {
			// 在用户输入 . 后提供建议被接受时，triggerWordRange 可能是 undfined。
			triggerWordRange = new vscode.Range(editor.selection.end, editor.selection.end);
		}
	} else {
		if (triggerWordRange) {
			triggerWord = editor.document.getText(triggerWordRange);
		} else {
			return;
		}
	}

	// 触发词前面必须是 . 字符
	let dotPosition = triggerWordRange.start.character > 0 ? triggerWordRange.start.translate(0, -1) : undefined;
	debugLog("dotPosition", dotPosition);
	if (!dotPosition) {
		return;
	}
	let dotStr = editor.document.getText(new vscode.Range(dotPosition, dotPosition.translate(0, 1)));
	if (!dotStr || dotStr !== '.') {
		return
	}

	// 检查模板配置是否包含此触发词
	let eachLangMap = languagePostfixTemplatesMap.get(editor.document.languageId)
	if (!eachLangMap) {
		return;
	}
	let template = eachLangMap.get(triggerWord);
	if (!template) {
		return;
	}

	// 获取模板应用于的target（也就是 . 前面的那部分）
	const textBeforeDot = editor.document.lineAt(dotPosition.line).text.substring(0, dotPosition.character);
	debugLog("textBeforeDot", textBeforeDot);
	let match = template.targetRegExp.exec(textBeforeDot);
	if (!match || !textBeforeDot.endsWith(match[0])) {
		return;
	}
	let target = match[0];
	debugLog("triggerWord", triggerWord, "target", target);
	if (!triggerWord) {
		return;
	}
	// if (target.endsWith('.' + triggerWord)) {
	// 	target = target.substring(0, target.length - triggerWord.length - 1)
	// }
	// debugLog("triggerWord", triggerWord, "targetWord", target);

	const snippet = templateToSnippet(template, target);
	if (snippet) {
		let replaceRange = new vscode.Range(dotPosition.translate(0, -target.length), triggerWordRange ? triggerWordRange.end : editor.selection.end);
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
		case "upperFistLetter": {
			return upperFistLetter;
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
function upperFistLetter(targetWord: string): string {
    return targetWord.charAt(0).toUpperCase() + targetWord.slice(1);
}
