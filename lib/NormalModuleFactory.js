/*
 MIT License http://www.opensource.org/licenses/mit-license.php
 Author Tobias Koppers @sokra
 */
"use strict";

const path = require("path");
const asyncLib = require("neo-async");
const {
	Tapable,
	AsyncSeriesWaterfallHook,
	SyncWaterfallHook,
	SyncBailHook,
	SyncHook,
	HookMap
} = require("tapable");
const NormalModule = require("./NormalModule");
const RawModule = require("./RawModule");
const RuleSet = require("./RuleSet");
const { cachedCleverMerge } = require("./util/cleverMerge");

const EMPTY_RESOLVE_OPTIONS = {};

const MATCH_RESOURCE_REGEX = /^([^!]+)!=!/;
// 工具函数：loader配置参数转成查询字符串
const loaderToIdent = data => {
	if (!data.options) {
		return data.loader;
	}
	if (typeof data.options === "string") {
		return data.loader + "?" + data.options;
	}
	if (typeof data.options !== "object") {
		throw new Error("loader options must be string or object");
	}
	if (data.ident) {
		return data.loader + "??" + data.ident;
	}
	return data.loader + "?" + JSON.stringify(data.options);
};
// 工具函数：loader查询字符串转成配置参数
const identToLoaderRequest = resultString => {
	const idx = resultString.indexOf("?");
	if (idx >= 0) {
		const loader = resultString.substr(0, idx);
		const options = resultString.substr(idx + 1);
		return {
			loader,
			options
		};
	} else {
		return {
			loader: resultString,
			options: undefined
		};
	}
};
// 缓存依赖
const dependencyCache = new WeakMap();

class NormalModuleFactory extends Tapable {
	// context: 执行上下文根目录，resolverFactory：一个可以创建resolver实例的对象，options：module配置项
	constructor(context, resolverFactory, options) {
		super();
		this.hooks = {
			resolver: new SyncWaterfallHook(["resolver"]),
			factory: new SyncWaterfallHook(["factory"]),
			beforeResolve: new AsyncSeriesWaterfallHook(["data"]),
			afterResolve: new AsyncSeriesWaterfallHook(["data"]),
			createModule: new SyncBailHook(["data"]),
			module: new SyncWaterfallHook(["module", "data"]),
			createParser: new HookMap(() => new SyncBailHook(["parserOptions"])),
			parser: new HookMap(() => new SyncHook(["parser", "parserOptions"])),
			createGenerator: new HookMap(
				() => new SyncBailHook(["generatorOptions"])
			),
			generator: new HookMap(
				() => new SyncHook(["generator", "generatorOptions"])
			)
		};
		this._pluginCompat.tap("NormalModuleFactory", options => {
			switch (options.name) {
				case "before-resolve":
				case "after-resolve":
					options.async = true;
					break;
				case "parser":
					this.hooks.parser
						.for("javascript/auto")
						.tap(options.fn.name || "unnamed compat plugin", options.fn);
					return true;
			}
			let match;
			match = /^parser (.+)$/.exec(options.name);
			if (match) {
				this.hooks.parser
					.for(match[1])
					.tap(
						options.fn.name || "unnamed compat plugin",
						options.fn.bind(this)
					);
				return true;
			}
			match = /^create-parser (.+)$/.exec(options.name);
			if (match) {
				this.hooks.createParser
					.for(match[1])
					.tap(
						options.fn.name || "unnamed compat plugin",
						options.fn.bind(this)
					);
				return true;
			}
		});
		// resolverFactory：一个可以创建resolver实例的对象，它的get(type, options)将创建一个resolver加载器
		this.resolverFactory = resolverFactory;
		// 解析 module.rules
		this.ruleSet = new RuleSet(options.defaultRules.concat(options.rules));
		this.cachePredicate =
			typeof options.unsafeCache === "function"
				? options.unsafeCache
				: Boolean.bind(null, options.unsafeCache);
		this.context = context || "";
		this.parserCache = Object.create(null);
		this.generatorCache = Object.create(null);
		// 给 factory 注册钩子函数，触发时返回一个 factory 函数
		// 返回的 factory 函数就是下面的钩子函数
		this.hooks.factory.tap("NormalModuleFactory", () => (result, callback) => {
			// 触发 resolver 返回一个 resolver 函数
			let resolver = this.hooks.resolver.call(null);

			// Ignored
			if (!resolver) return callback();
			// 很重要：解析loader，添加parser、generator
			// data中包含了模块路径、loader路径和参数等等信息
			// 具体操作见下面 resolver 注册的钩子函数
			resolver(result, (err, data) => {
				if (err) return callback(err);

				// Ignored
				if (!data) return callback();

				// direct module
				if (typeof data.source === "function") return callback(null, data);

				this.hooks.afterResolve.callAsync(data, (err, result) => {
					if (err) return callback(err);

					// Ignored
					if (!result) return callback();
					// 触发 createModule 钩子，如果有插件监听这个事件，并返回自定义的 createdModule
					// 则不使用默认的 NormalModule()
					let createdModule = this.hooks.createModule.call(result);
					if (!createdModule) {
						if (!result.request) {
							return callback(new Error("Empty dependency (no request)"));
						}
						// 创建一个普通模块
						createdModule = new NormalModule(result);
					}
					// 触发 module 钩子，如果有插件监听这个事件，可以修改这个 createdModule
					createdModule = this.hooks.module.call(createdModule, result);
					// 返回这个 createdModule
					return callback(null, createdModule);
				});
			});
		});
		// 给 resolver 注册钩子函数，触发时返回一个 resolver 函数
		// 返回的 resolver 函数就是下面的钩子函数
		this.hooks.resolver.tap("NormalModuleFactory", () => (data, callback) => {
			const contextInfo = data.contextInfo;
			const context = data.context;
			const request = data.request;
			// 调用 this.resolverFactory.get(type, options) 创建一个 resolver 加载器
			// 创建 loader、normal 加载器
			// 例如加载 js 必须先加载 babel-loader 然后再加载 js 文件
			const loaderResolver = this.getResolver("loader"); // 加载 loader
			const normalResolver = this.getResolver("normal", data.resolveOptions); // 加载真正的模块

			let matchResource = undefined;
			let requestWithoutMatchResource = request;
			// 对加载文件的路径进行一些特殊判断
			// Loader 的内联用法(不推荐) https://webpack.docschina.org/concepts/loaders/#inline
			// import Styles from 'style-loader!css-loader?modules!./styles.css'
			// 等这样的路径进行特殊处理
			// 以!分割
			const matchResourceMatch = MATCH_RESOURCE_REGEX.exec(request);
			if (matchResourceMatch) {
				matchResource = matchResourceMatch[1];
				// 匹配到 './' 或 '../'
				if (/^\.\.?\//.test(matchResource)) {
					matchResource = path.join(context, matchResource);
				}
				requestWithoutMatchResource = request.substr(
					matchResourceMatch[0].length
				);
			}
			// 判断是否以 '-!' 为前缀
			// 使用 -! 前缀，将禁用所有已配置的 preLoader 和 loader，但是不禁用 postLoaders
			const noPreAutoLoaders = requestWithoutMatchResource.startsWith("-!");
			// 判断是否以 '!' 为前缀
			// 使用 ! 前缀，将禁用所有已配置的 normal loader(普通 loader)
			const noAutoLoaders =
				noPreAutoLoaders || requestWithoutMatchResource.startsWith("!");
			// 判断是否以 '!！' 为前缀
			// 使用 !! 前缀，将禁用所有已配置的 loader（preLoader, loader, postLoader）
			const noPrePostAutoLoaders = requestWithoutMatchResource.startsWith("!!");
			let elements = requestWithoutMatchResource
				.replace(/^-?!+/, "")
				.replace(/!!+/g, "!")
				.split("!");
			// 加载的文件路径
			let resource = elements.pop();
			// 转换路径上配置的 loader 参数
			elements = elements.map(identToLoaderRequest);
			// 循环调用数组中的函数，执行完毕后，执行第二个参数的回调函数
			// 先加载loader，然后加载真正文件
			asyncLib.parallel(
				[
					// 加载需要的loader
					callback =>
						this.resolveRequestArray(
							contextInfo,
							context,
							elements,
							loaderResolver,
							callback
						),
					// 加载真正的模块
					callback => {
						if (resource === "" || resource[0] === "?") {
							return callback(null, {
								resource
							});
						}

						normalResolver.resolve(
							contextInfo,
							context,
							resource,
							{},
							(err, resource, resourceResolveData) => {
								if (err) return callback(err);
								callback(null, {
									resourceResolveData,
									resource
								});
							}
						);
					}
				],
				(err, results) => {
					if (err) return callback(err);
					// results[0]包含loader相关的数据  results[1]包含真正的模块数据
					let loaders = results[0];
					const resourceResolveData = results[1].resourceResolveData;
					resource = results[1].resource;

					// translate option idents
					try {
						for (const item of loaders) {
							if (typeof item.options === "string" && item.options[0] === "?") {
								const ident = item.options.substr(1);
								item.options = this.ruleSet.findOptionsByIdent(ident);
								item.ident = ident;
							}
						}
					} catch (e) {
						return callback(e);
					}

					if (resource === false) {
						// ignored
						return callback(
							null,
							new RawModule(
								"/* (ignored) */",
								`ignored ${context} ${request}`,
								`${request} (ignored)`
							)
						);
					}
					// loaders!request
					const userRequest =
						(matchResource !== undefined ? `${matchResource}!=!` : "") +
						loaders
							.map(loaderToIdent)
							.concat([resource])
							.join("!");

					let resourcePath =
						matchResource !== undefined ? matchResource : resource;
					let resourceQuery = "";
					const queryIndex = resourcePath.indexOf("?");
					if (queryIndex >= 0) {
						resourceQuery = resourcePath.substr(queryIndex);
						resourcePath = resourcePath.substr(0, queryIndex);
					}

					const result = this.ruleSet.exec({
						resource: resourcePath,
						realResource:
							matchResource !== undefined
								? resource.replace(/\?.*/, "")
								: resourcePath,
						resourceQuery,
						issuer: contextInfo.issuer,
						compiler: contextInfo.compiler
					});
					const settings = {};
					const useLoadersPost = [];
					const useLoaders = [];
					const useLoadersPre = [];
					for (const r of result) {
						if (r.type === "use") {
							// Rule.enforce配置项的处理，影响loader的加载顺序
							// pre前置loader  post后置loader   正常loader
							if (r.enforce === "post" && !noPrePostAutoLoaders) {
								useLoadersPost.push(r.value);
							} else if (
								r.enforce === "pre" &&
								!noPreAutoLoaders &&
								!noPrePostAutoLoaders
							) {
								useLoadersPre.push(r.value);
							} else if (
								!r.enforce &&
								!noAutoLoaders &&
								!noPrePostAutoLoaders
							) {
								useLoaders.push(r.value);
							}
						} else if (
							typeof r.value === "object" &&
							r.value !== null &&
							typeof settings[r.type] === "object" &&
							settings[r.type] !== null
						) {
							settings[r.type] = cachedCleverMerge(settings[r.type], r.value);
						} else {
							settings[r.type] = r.value;
						}
					}
					// 循环执行数组中的函数，最后执行第二参数回调
					// 按Rule.enforce配置项，加载loader
					asyncLib.parallel(
						[
							this.resolveRequestArray.bind(
								this,
								contextInfo,
								this.context,
								useLoadersPost,
								loaderResolver
							),
							this.resolveRequestArray.bind(
								this,
								contextInfo,
								this.context,
								useLoaders,
								loaderResolver
							),
							this.resolveRequestArray.bind(
								this,
								contextInfo,
								this.context,
								useLoadersPre,
								loaderResolver
							)
						],
						(err, results) => {
							if (err) return callback(err);
							// 获得所有的 loaders
							if (matchResource === undefined) {
								loaders = results[0].concat(loaders, results[1], results[2]);
							} else {
								loaders = results[0].concat(results[1], loaders, results[2]);
							}
							// 异步加载loaders和源码
							process.nextTick(() => {
								const type = settings.type;
								const resolveOptions = settings.resolve;
								callback(null, {
									context: context,
									request: loaders
										.map(loaderToIdent)
										.concat([resource])
										.join("!"),
									dependencies: data.dependencies,
									userRequest,
									rawRequest: request,
									loaders,
									resource,
									matchResource,
									resourceResolveData,
									settings,
									type,
									parser: this.getParser(type, settings.parser), // 创建parser
									generator: this.getGenerator(type, settings.generator), // 创建generator
									resolveOptions
								});
							});
						}
					);
				}
			);
		});
	}
	// 创建模块
	create(data, callback) {
		const dependencies = data.dependencies;
		const cacheEntry = dependencyCache.get(dependencies[0]);
		if (cacheEntry) return callback(null, cacheEntry);
		const context = data.context || this.context;
		const resolveOptions = data.resolveOptions || EMPTY_RESOLVE_OPTIONS;
		const request = dependencies[0].request;
		const contextInfo = data.contextInfo || {};
		this.hooks.beforeResolve.callAsync(
			{
				contextInfo,
				resolveOptions,
				context,
				request,
				dependencies
			},
			(err, result) => {
				if (err) return callback(err);

				// Ignored
				if (!result) return callback();
				// 触发factory钩子，返回一个创建模块的函数
				// 在此文件的94行注册
				const factory = this.hooks.factory.call(null);

				// Ignored
				if (!factory) return callback();
				// 创建模块
				factory(result, (err, module) => {
					if (err) return callback(err);

					if (module && this.cachePredicate(module)) {
						for (const d of dependencies) {
							dependencyCache.set(d, module);
						}
					}
					// 返回创建的模块
					callback(null, module);
				});
			}
		);
	}
	// 循环解析
	resolveRequestArray(contextInfo, context, array, resolver, callback) {
		if (array.length === 0) return callback(null, []);
		asyncLib.map(
			array,
			(item, callback) => {
				resolver.resolve(
					contextInfo,
					context,
					item.loader,
					{},
					(err, result) => {
						if (
							err &&
							/^[^/]*$/.test(item.loader) &&
							!/-loader$/.test(item.loader)
						) {
							return resolver.resolve(
								contextInfo,
								context,
								item.loader + "-loader",
								{},
								err2 => {
									if (!err2) {
										err.message =
											err.message +
											"\n" +
											"BREAKING CHANGE: It's no longer allowed to omit the '-loader' suffix when using loaders.\n" +
											`                 You need to specify '${item.loader}-loader' instead of '${item.loader}',\n` +
											"                 see https://webpack.js.org/migrate/3/#automatic-loader-module-name-extension-removed";
									}
									callback(err);
								}
							);
						}
						if (err) return callback(err);

						const optionsOnly = item.options
							? {
									options: item.options
							  }
							: undefined;
						return callback(
							null,
							Object.assign({}, item, identToLoaderRequest(result), optionsOnly)
						);
					}
				);
			},
			callback
		);
	}

	getParser(type, parserOptions) {
		let ident = type;
		if (parserOptions) {
			if (parserOptions.ident) {
				ident = `${type}|${parserOptions.ident}`;
			} else {
				ident = JSON.stringify([type, parserOptions]);
			}
		}
		if (ident in this.parserCache) {
			return this.parserCache[ident];
		}
		return (this.parserCache[ident] = this.createParser(type, parserOptions));
	}

	createParser(type, parserOptions = {}) {
		const parser = this.hooks.createParser.for(type).call(parserOptions);
		if (!parser) {
			throw new Error(`No parser registered for ${type}`);
		}
		this.hooks.parser.for(type).call(parser, parserOptions);
		return parser;
	}

	getGenerator(type, generatorOptions) {
		let ident = type;
		if (generatorOptions) {
			if (generatorOptions.ident) {
				ident = `${type}|${generatorOptions.ident}`;
			} else {
				ident = JSON.stringify([type, generatorOptions]);
			}
		}
		if (ident in this.generatorCache) {
			return this.generatorCache[ident];
		}
		return (this.generatorCache[ident] = this.createGenerator(
			type,
			generatorOptions
		));
	}

	createGenerator(type, generatorOptions = {}) {
		const generator = this.hooks.createGenerator
			.for(type)
			.call(generatorOptions);
		if (!generator) {
			throw new Error(`No generator registered for ${type}`);
		}
		this.hooks.generator.for(type).call(generator, generatorOptions);
		return generator;
	}

	getResolver(type, resolveOptions) {
		return this.resolverFactory.get(
			type,
			resolveOptions || EMPTY_RESOLVE_OPTIONS
		);
	}
}

module.exports = NormalModuleFactory;
