/* eslint no-console: 0 */

const chalk = require('chalk');
const path = require('path');
const rollup = require('rollup');
const rbabel = require('rollup-plugin-babel');
const resolve = require('rollup-plugin-node-resolve');
const commonjs = require('rollup-plugin-commonjs'); 
const alias = require('rollup-plugin-alias');
const nodeResolve = require('resolve');
const chokidar = require('chokidar');
const fs = require('fs-extra');
const glob = require('glob');
const utils = require('./utils');
const crypto = require('crypto');
const config = require('./config');
const quickFiles = require('./quickFiles');
const miniTransform = require('./miniappTransform');
const styleTransform = require('./styleTransform');
const generate = require('./generate');
const Timer = require('./utils/timer');
let cwd = process.cwd();
let inputPath = path.join(cwd,  config.sourceDir);
let cache = {};
let needUpdate = (id, code) => {
    let sha1 = crypto
        .createHash('sha1')
        .update(code)
        .digest('hex');
    if (!cache[id] || cache[id] != sha1) {
        cache[id] = sha1;
        return true;
    }
    return false;
};
const isStyle = path => {
    return /\.(?:less|scss|sass)$/.test(path);
};
const isJs = path => {
    return /\.js$/.test(path);
};
const isJson = path => {
    return /\.json$/.test(path);
};
const getFileType = (id)=>{
    if (isStyle(id)){
        return 'css';
    } else if (isJs(id)) {
        return 'js';
    } else if (isJson(id)){
        return 'json';
    }
};

//跳过rollup对样式内容解析
let ignoreStyleParsePlugin = ()=>{
    return {
        transform: function(code, id){
            let styleExtList = ['.css', '.less', '.scss', '.sass'];
            let ext = path.extname(id);
            if (styleExtList.includes(ext)) return {
                code: ''
            };
        }
    };
};

//监听打包资源
utils.on('build', (data)=>{
    const { size, index, filepath } = data;
    const outputPath = utils.resolveDistPath(filepath);
    console.log(
        chalk.gray(`[${index}] `) + 
        chalk.green(`build success: ${path.relative(cwd, outputPath)} `) +
        chalk.gray(`[${size}]`)
    );
});

class Parser {
    constructor(entry) {
        this.entry = entry;
        this.jsFiles = [];
        this.styleFiles = [];
        this.npmFiles = [];
        this.webViewRoutes = [];
        this.depTree = {};
        this.collectError = {
            //样式@import引用错误, 如page中引用component样式
            styleImportError: [],
            //page or component js代码是否超过500行
            jsCodeLineNumberError: [],
            //page中是否包含了component目录
            componentInPageError: [],
            jsxError: [],
            // 引用的组件是否符合规范
            componentsStandardError: []
        };
        
        this.customAliasConfig = Object.assign(
            { resolve: ['.js','.css', '.scss', '.sass', '.less'] },
            utils.getAliasConfig()
        );
        
        this.inputConfig = {
            input: this.entry,
            plugins: [
                alias(this.customAliasConfig), //搜集依赖时候，能找到对应的alias配置路径
                resolve({
                    
                    jail: path.join(cwd, 'node_modules'),   //从项目根目录中搜索npm模块, 防止向父级查找
                    preferBuiltins: false,  //防止查找内置模块
                    customResolveOptions: {
                        packageFilter: function(pkg, pkgFile){
                            if (  !pkg.main && !pkg.module ) {
                                pkg.main = pkg.module = './index.js';
                            }
                            return pkg;
                        }
                    },
                   
                }),
                ignoreStyleParsePlugin(),
                commonjs({
                    include: 'node_modules/**',
                    exclude: ['node_modules/schnee-ui/**'] //防止解析ui库中的jsx报错
                }),
                rbabel({
                    babelrc: false,
                    only: ['**/*.js'],
                    // exclude: 'node_modules/**',
                    /**
                     * root
                     * 防止读取外部 babel 配置文件，如去掉 root 配置在快应用下会
                     * 读取 babel.config.js 文件导致报错
                     */
                    root: path.join(__dirname, '..'),
                    configFile: false,
                    presets: [
                        require('@babel/preset-react')
                    ],
                    plugins: [
                        /**
                         * [babel 6 to 7] 
                         * v6 default config: ["plugin", { "loose": true }]
                         * v7 default config: ["plugin"]
                         */
                        [
                            require('@babel/plugin-proposal-class-properties'),
                            { loose: true }
                        ],
                        require('@babel/plugin-proposal-object-rest-spread'),
                        [
                            //重要,import { Xbutton } from 'schnee-ui' //按需引入
                            require('babel-plugin-import').default,
                            {
                                libraryName: 'schnee-ui',
                                libraryDirectory: 'components',
                                camel2DashComponentName: false
                            }
                        ],
                        require('./babelPlugins/collectTitleBarConfig'),
                        require('./babelPlugins/collectWebViewPage'),
                        require('./babelPlugins/collectPatchComponents'),
                        ...require('./babelPlugins/validateJsx')(this.collectError)
                    ]
                })
            ],
            onwarn: warning => {
                //warning.importer 缺失依赖文件路径
                //warning.source   依赖的模块名
                
                if (warning.code === 'UNRESOLVED_IMPORT') {
                    console.log(warning);
                    process.exit(1);
                }
            }
        };
        
    }
    async resolvePatchComponentModules() {
        let modules = [];
        const patchComponents = config.patchComponents;
        for (let key in patchComponents) {
            this.inputConfig.input = patchComponents[key];
            const patchBundle = await rollup.rollup(this.inputConfig);
            modules = modules.concat(patchBundle.modules);
        }
        return modules;
    }
    async parse() {
        let timer = new Timer();
        let spinner = utils.spinner(chalk.green('正在分析依赖...\n')).start();

        // 分析依赖
        let bundle = await rollup.rollup(this.inputConfig);
        //如果有需要打补丁的组件并且本地没有安装schnee-ui
        if (this.needInstallUiLib()) {
            console.log(chalk.green('缺少补丁组件, 正在安装, 请稍候...'));
            utils.installer('schnee-ui');
        }

       

        //校验是否需要安装快应用hap-toolkit工具
        if (this.needInstallHapToolkit()) {
            //获取package.json中hap-toolkit版本，并安装
            let toolName = 'hap-toolkit';
            console.log(chalk.green(`缺少快应用构建工具${toolName}, 正在安装, 请稍候...`));
            utils.installer(
                `${toolName}@${require( path.join(cwd, 'package.json'))['devDependencies'][toolName] }`,
                '--save-dev'
            );
        }
        // 分析补丁组件依赖
        const patchModules = await this.resolvePatchComponentModules();
        // 合并依赖，去重
        bundle.modules = utils.uniquefilter(bundle.modules.concat(patchModules), 'id');
        timer.end();
        spinner.succeed(`依赖分析成功, 用时: ${timer.getProcessTime()}s`);
    
        timer = new Timer();
        let moduleMap = this.moduleMap();
        bundle.modules.forEach(item => {
            if (/commonjsHelpers|rollupPluginBabelHelpers\.js/.test(item.id)) return;
            let hander = moduleMap[getFileType(item.id)];
            if (hander) {
                hander(item);
            }
            this.collectDeps(item);
        });

        this.check();
        this.updateWebViewRoutes(this.webViewRoutes);
        await this.transform();
        generate();
        timer.end();
        utils.spinner('').succeed(`构建结束, 用时: ${timer.getProcessTime()}s\n`);
        if (config.buildType === 'quick'){
            console.log(chalk.magentaBright('请打开另一个窗口, 执行构建快应用命令'), chalk.greenBright('npm run build'));
            console.log(chalk.magentaBright('在打开另一个窗口, 执行启动快应用调试服务'), chalk.greenBright('npm run server'));
        }

    }
    needInstallUiLib() {
        if ( !config[config.buildType].jsxPatchNode ) return false; //没有需要patch的组件
        try {
            nodeResolve.sync('schnee-ui', { basedir: process.cwd() });
            return false;
        } catch (err) {
            return true;
        }
    }
    needInstallHapToolkit(){
        if (config.buildType !== 'quick') return false;
        //检查本地是否安装快应用的hap-toolkit工具
        try {
            //hap-toolkit中package.json没有main或者module字段, 无法用 nodeResolve 来判断是否存在。
            //nodeResolve.sync('hap-toolkit', { basedir: process.cwd() });
            let hapToolKitPath = path.join(cwd, 'node_modules', 'hap-toolkit');
            fs.accessSync(hapToolKitPath);
            return false;
        } catch (err) {
            return true;
        }
    }
    collectDeps(item) {
        //搜集js的样式依赖，快应用下如果更新样式，需触发js构建ux.
        if ( !/\.js$/.test(item.id) ) return;
        let depsStyle = item.dependencies.filter((id)=>{
            return isStyle(id);
        });
        if (depsStyle.length) {
            this.depTree[item.id] = depsStyle;
        }
    }
    moduleMap() {
        return {
            css: (data)=>{
                this.checkStyleImport(data);
                if (config.buildType == 'quick') {
                    return;
                }
                this.styleFiles.push({
                    id: data.id,
                    originalCode: data.originalCode
                });
            },
            js: (data)=>{
                //校验文件代码行数是否超过500, 抛出警告。
                this.checkCodeLine(data.id, data.originalCode, 500);
                //校验pages目录中是否包含components目录
                this.checkComponentsInPages(data.id);
                //校验组件组件名以及文件夹是否符合规范
                this.checkImportComponent(data);

                if (utils.isWebView(data.id)) {
                    this.webViewRoutes.push({
                        id: data.id
                    });
                } else {
                    //搜集js中依赖的样式，存入quickFiles
                    this.collectQuickDepStyle(data);
                    this.jsFiles.push(data);
                }
               
            }
        };
    }

    checkImportComponent(item){
        let importList = item.code.match(/^(?:import)\s+([^;]+)/igm) || [];
      
        importList = importList.filter((importer)=>{
            return /[\/|@]components\//.test(importer);
        });

        importList.forEach((importer)=>{
             // import Welcome from '@components/Welcome/index' => ['Welcome', '@components/Welcome/index']
             // import Welcome, {xxx, yyy } from '@components/Welcome/index' => ['Welcome', '@components/Welcome/index']
             // import Layout, { GlobalTheme } from '@components/Layout/index'
             let arr = importer.split(/\s+|,|\{|\}/).filter(function(el){
                  return !(el == '' || el === 'from' || el === 'import')
             })
            
             let importName = arr.shift();
             let segments = arr.pop().match(/\w+/g);
             let fileName = segments.pop();
              // @components/Welcome/index ==》Welcome
             let folderName = segments.pop();
             let msg = '';
             if ( fileName!='index' ) {
                 msg = '组件文件名必须是index';
                 msg += `\nerror at: ${importer}`
             } else if ( importName != folderName){
                 msg = '引用的组件名必须和组件所在的文件夹名保持一致'
                      + `\n例如: import ${folderName} from \'@components/${folderName}/index\'`;
                 msg += `\nerror at: ${item.id}`
             }

             if (!msg) return;
             
             this.collectError.componentsStandardError.push({
                 id: item.id,
                 level: 'error',
                 msg: msg
             });
        });
    }
    async transform() {
       
        await this.updateJsQueue(this.jsFiles);
        await this.updateStyleQueue(this.styleFiles);
    }
    check() {
        let errorMsg = '';
        let warningMsg = '';
        Object.keys(this.collectError).forEach((key)=>{
            this.collectError[key].forEach((info)=>{
                switch (info.level) {
                    case 'error':
                        errorMsg += `Error: ${info.msg}\n`;
                        break;
                    case 'warning':
                        warningMsg += `Warning: ${info.msg}\n`;
                        break;
                }
            });
            this.collectError[key] = [];
        });
        
        if ( warningMsg ) {
            console.log(chalk.yellow(warningMsg));
        }
        if ( errorMsg ) {
            console.log(chalk.red(errorMsg));
            process.exit(1);
        }
    }
    collectQuickDepStyle(data){
        if (config.buildType === 'quick') {
            let cssPath = data.dependencies.filter((fileId)=>{
                return isStyle(fileId);
            })[0];
            if (cssPath) {
                let extname = path.extname(cssPath).replace(/^\./, '');
                quickFiles[data.id] = {
                    cssPath: cssPath,
                    cssType: extname == 'scss' ? 'sass' : extname
                };
            }
        }
    }
    checkComponentsInPages(id) {
        id = path.relative( cwd,  id);
        let pathAray = utils.isWin() ? id.split('\\') :  id.split('/'); //分割目录
        let componentsPos = pathAray.indexOf('components');
        let pagesPos = pathAray.indexOf('pages');
        let msg = '';
        if ( !( componentsPos != -1 && pagesPos != -1 ) ) return;
        componentsPos > pagesPos
            ? msg = `${id} 文件中路径中不能包含components目录, 请修复.`
            : msg = `${id} 文件中路径中不能包含pages目录, 请修复.`;
        this.collectError.componentInPageError.push({
            id: id,
            level: 'error',
            msg: msg
        });
        
    }
    checkCodeLine(filePath, code, number){
        if ( /^(React)/.test(path.basename(filePath)) ) return; //React runtime不校验代码行数
        let line =  code.match(/\n/g);
        if ( !line || line.length <= number ) return;
        let id = path.relative( cwd,  filePath);
        this.collectError.jsCodeLineNumberError.push({
            id: id,
            level: 'warning',
            msg: `${id} 文件代码不能超过${number}行, 请优化.`
        });
    }
    checkStyleImport (data){
        let id = path.relative(cwd, data.id);
        let importList = data.originalCode.match(/^(?:@import)\s+([^;]+)/igm) || [];
        importList = importList.filter((importer)=>{
            return /[/|@]components\//.test(importer);
        });
       
        if (!importList.length) return;
        this.collectError.styleImportError.push({
            id: id,
            level: 'error',
            msg: `${id} 文件中不能@import 组件(components)样式, 组件样式请在组件中引用, 请修复.`
        });
    }
    async updateJsQueue(jsFiles) {
        while (jsFiles.length) {
            let item = jsFiles.shift();
            
            if (/commonjs-proxy:/.test(item.id)) {
                item.id = item.id.replace('commonjs-proxy:', '').replace('\u0000','');
            }
            let { id, originalCode, resolvedIds } = item;
            if (needUpdate(id, originalCode)) {
                await miniTransform(id, resolvedIds, originalCode);
            }
        }
    }
    updateWebViewRoutes(webViewRoutes){
        require('./utils/setWebVeiw')(webViewRoutes);
    }
    async updateStyleQueue(styleFiles) {
        while (styleFiles.length) {
            let { id, originalCode } = styleFiles.shift(); 
            if (needUpdate(id, originalCode)) {
                await styleTransform({
                    id: id,
                    originalCode: originalCode
                }); 
            }
        }
    }
    copyAssets() {
        const dir = 'assets';
        const inputDir = path.join(inputPath, dir);
        //拷贝assets下非js, css, sass, scss, less文件
        glob(inputDir + '/**', {nodir: true}, (err, files)=>{
            if (err) {
                console.log(err);
                return;
            }
            files.forEach((filePath)=>{
                if ( /\.(js|scss|sass|less|css)$/.test(filePath) ) return;
                filePath = path.resolve(filePath);
                let dist  = utils.updatePath(
                    filePath, 
                    config.sourceDir, 
                    config.buildType === 'quick' ? 'src' : config.buildDir
                );
                
                fs.ensureFileSync(dist);
                fs.copyFile(filePath, dist, (err)=>{
                    if (err ) {
                        console.log(err);
                    }
                });
            });
        });

    }
    copyProjectConfig() {
        //copy project.config.json
        if ( ['ali', 'bu', 'quick'].includes( config.buildType) ) return;
        let fileName = 'project.config.json';
        let dist = path.join(cwd, config.buildDir, fileName);
        let src = path.join(cwd, fileName);
        fs.ensureFileSync(dist);
        fs.copyFile( src, dist, (err)=>{
            if (err) {
                //console.log(err);
            }
        });
    }
    watching() {
        let watchDir = path.dirname(this.entry);
        let watchConfig = {
            ignored: /(\.DS_Store|\.gitignore|\.git|\.json$)/,
            awaitWriteFinish: {
                stabilityThreshold: 700,
                pollInterval: 100
            }
        };
        const watcher = chokidar
            .watch(watchDir, watchConfig)
            .on('change', (file)=>{
                console.log(
                    `\n更新: ${chalk.yellow(path.relative(cwd, file))}`
                );
                this.inputConfig.input = this.resolveWatchFile(file);
                this.parse();
                
            });
        watcher.on('error', error => {
            console.error('Watcher failure', error);
            process.exit(1);
        });
    }
    resolveWatchFile(file) {
        if (config.buildType !== 'quick') return file;
        let dep = file;
        for ( let i in this.depTree) {
            if (this.depTree[i].includes(file)) {
                dep = i;
                break;
            }
        }
        delete cache[dep];
        return dep;
    }
}

module.exports = (entry)=>{
    return new Parser(entry);
};
