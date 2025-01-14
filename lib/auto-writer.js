"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoWriter = void 0;
const fs_1 = __importDefault(require("fs"));
const lodash_1 = __importDefault(require("lodash"));
const path_1 = __importDefault(require("path"));
const util_1 = __importDefault(require("util"));
const sequelize_1 = require("sequelize");
const types_1 = require("./types");
const mkdirp = require('mkdirp');
/** Writes text into files from TableData.text, and writes init-models */
class AutoWriter {
    constructor(tableData, options) {
        this.tableText = tableData.text;
        this.foreignKeys = tableData.foreignKeys;
        this.relations = tableData.relations;
        this.options = options;
    }
    write() {
        if (this.options.noWrite) {
            return Promise.resolve();
        }
        mkdirp.sync(path_1.default.resolve(this.options.directory || './models'));
        const tables = lodash_1.default.keys(this.tableText);
        // write the individual model files
        const promises = tables.map((t) => {
            return this.createFile(t);
        });
        const isTypeScript = this.options.lang === 'ts';
        const assoc = this.createAssociations(isTypeScript);
        // get table names without schema
        // TODO: add schema to model and file names when schema is non-default for the dialect
        const tableNames = tables
            .map((t) => {
            const [schemaName, tableName] = types_1.qNameSplit(t);
            return tableName;
        })
            .sort();
        // write the init-models file
        if (!this.options.noInitModels) {
            const initString = this.createInitString(tableNames, assoc, this.options.lang);
            const initFilePath = path_1.default.join(this.options.directory, 'index' + (isTypeScript ? '.ts' : '.js'));
            const writeFile = util_1.default.promisify(fs_1.default.writeFile);
            const initPromise = writeFile(path_1.default.resolve(initFilePath), initString);
            promises.push(initPromise);
        }
        return Promise.all(promises);
    }
    createInitString(tableNames, assoc, lang) {
        switch (lang) {
            case 'ts':
                return this.createTsInitString(tableNames, assoc);
            case 'esm':
                return this.createESMInitString(tableNames, assoc);
            case 'custom':
                return this.createCustomInitString(tableNames, assoc);
            default:
                return this.createES5InitString(tableNames, assoc);
        }
    }
    createFile(table) {
        // FIXME: schema is not used to write the file name and there could be collisions. For now it
        // is up to the developer to pick the right schema, and potentially chose different output
        // folders for each different schema.
        const [schemaName, tableName] = types_1.qNameSplit(table);
        const fileName = types_1.recase(this.options.caseFile, tableName, this.options.singularize);
        const filePath = path_1.default.join(this.options.directory, fileName + '.model' + (this.options.lang === 'ts' ? '.ts' : '.js'));
        const writeFile = util_1.default.promisify(fs_1.default.writeFile);
        return writeFile(path_1.default.resolve(filePath), this.tableText[table]);
    }
    /** Create the belongsToMany/belongsTo/hasMany/hasOne association strings */
    createAssociations(typeScript) {
        let strBelongs = '';
        let strBelongsToMany = '';
        const rels = this.relations;
        rels.forEach((rel) => {
            if (rel.isM2M) {
                const asprop = types_1.pluralize(rel.childProp);
                strBelongsToMany += `  ${rel.parentModel}.belongsToMany(${rel.childModel}, { as: '${asprop}', through: ${rel.joinModel}, foreignKey: "${rel.parentId}", otherKey: "${rel.childId}" });\n`;
            }
            else {
                const bAlias = this.options.noAlias && rel.parentModel.toLowerCase() === rel.parentProp.toLowerCase()
                    ? ''
                    : `as: "${rel.parentProp}", `;
                strBelongs += `  ${rel.childModel}.belongsTo(${rel.parentModel}, { ${bAlias}foreignKey: "${rel.parentId}"});\n`;
                const hasRel = rel.isOne ? 'hasOne' : 'hasMany';
                const hAlias = this.options.noAlias && sequelize_1.Utils.pluralize(rel.childModel.toLowerCase()) === rel.childProp.toLowerCase()
                    ? ''
                    : `as: "${rel.childProp}", `;
                strBelongs += `  ${rel.parentModel}.${hasRel}(${rel.childModel}, { ${hAlias}foreignKey: "${rel.parentId}"});\n`;
            }
        });
        // belongsToMany must come first
        return strBelongsToMany + strBelongs;
    }
    // create the TypeScript init-models file to load all the models into Sequelize
    createTsInitString(tables, assoc) {
        let str = 'import type { Sequelize, Model } from "sequelize";\n';
        const modelNames = [];
        // import statements
        tables.forEach((t) => {
            const fileName = types_1.recase(this.options.caseFile, t, this.options.singularize);
            const modelName = types_1.recase(this.options.caseModel, t, this.options.singularize);
            modelNames.push(modelName);
            str += `import { ${modelName} } from "./${fileName}";\n`;
            str += `import type { ${modelName}Attributes, ${modelName}CreationAttributes } from "./${fileName}";\n`;
        });
        // re-export the model classes
        str += '\nexport {\n';
        modelNames.forEach((m) => {
            str += `  ${m},\n`;
        });
        str += '};\n';
        // re-export the model attirbutes
        str += '\nexport type {\n';
        modelNames.forEach((m) => {
            str += `  ${m}Attributes,\n`;
            str += `  ${m}CreationAttributes,\n`;
        });
        str += '};\n\n';
        // create the initialization function
        str += 'export function initModels(sequelize: Sequelize) {\n';
        modelNames.forEach((m) => {
            str += `  ${m}.initModel(sequelize);\n`;
        });
        // add the asociations
        str += '\n' + assoc;
        // return the models
        str += '\n  return {\n';
        modelNames.forEach((m) => {
            str += `    ${m}: ${m},\n`;
        });
        str += '  };\n';
        str += '}\n';
        return str;
    }
    // create the ES5 init-models file to load all the models into Sequelize
    createES5InitString(tables, assoc) {
        let str = 'var DataTypes = require("sequelize").DataTypes;\n';
        const modelNames = [];
        // import statements
        tables.forEach((t) => {
            const fileName = types_1.recase(this.options.caseFile, t, this.options.singularize);
            const modelName = types_1.recase(this.options.caseModel, t, this.options.singularize);
            modelNames.push(modelName);
            str += `var _${modelName} = require("./${fileName}");\n`;
        });
        // create the initialization function
        str += '\nfunction initModels(sequelize) {\n';
        modelNames.forEach((m) => {
            str += `  var ${m} = _${m}(sequelize, DataTypes);\n`;
        });
        // add the asociations
        str += '\n' + assoc;
        // return the models
        str += '\n  return {\n';
        modelNames.forEach((m) => {
            str += `    ${m},\n`;
        });
        str += '  };\n';
        str += '}\n';
        str += 'module.exports = initModels;\n';
        str += 'module.exports.initModels = initModels;\n';
        str += 'module.exports.default = initModels;\n';
        return str;
    }
    // create the ESM init-models file to load all the models into Sequelize
    createESMInitString(tables, assoc) {
        let str = 'import _sequelize from "sequelize";\n';
        str += 'const DataTypes = _sequelize.DataTypes;\n';
        const modelNames = [];
        // import statements
        tables.forEach((t) => {
            const fileName = types_1.recase(this.options.caseFile, t, this.options.singularize);
            const modelName = types_1.recase(this.options.caseModel, t, this.options.singularize);
            modelNames.push(modelName);
            str += `import _${modelName} from  "./${fileName}.js";\n`;
        });
        // create the initialization function
        str += '\nexport default function initModels(sequelize) {\n';
        modelNames.forEach((m) => {
            str += `  var ${m} = _${m}.init(sequelize, DataTypes);\n`;
        });
        // add the asociations
        str += '\n' + assoc;
        // return the models
        str += '\n  return {\n';
        modelNames.forEach((m) => {
            str += `    ${m},\n`;
        });
        str += '  };\n';
        str += '}\n';
        return str;
    }
    // create the Custom init-models file to load all the models into Sequelize
    createCustomInitString(tables, assoc) {
        let str = `import Sequelize from 'sequelize';\n\n`;
        str += `import {\n`;
        str += `  DB,\n`;
        str += `  USER,\n`;
        str += `  PASSWORD,\n`;
        str += `  HOST,\n`;
        str += `  dialect as _dialect,\n`;
        str += `  pool as _pool,\n`;
        str += `} from '../config/db.config.js';\n\n`;
        const modelNames = [];
        // import statements
        tables.forEach((t) => {
            const fileName = types_1.recase(this.options.caseFile, t, this.options.singularize);
            const modelName = types_1.recase(this.options.caseModel, t, this.options.singularize);
            modelNames.push(modelName);
            str += `import ${modelName} from './${fileName}.model.js';\n`;
        });
        str += `\nconst sequelize = new Sequelize(DB, USER, PASSWORD, {\n`;
        str += `  host: HOST,\n`;
        str += `  dialect: _dialect,\n\n`;
        str += `  pool: {\n`;
        str += `    max: _pool.max,\n`;
        str += `    min: _pool.min,\n`;
        str += `    acquire: _pool.acquire,\n`;
        str += `    idle: _pool.idle,\n`;
        str += `  },\n`;
        str += `});\n\n`;
        str += `const models = {\n`;
        tables.forEach((t) => {
            const fileName = types_1.recase(this.options.caseFile, t, this.options.singularize);
            const modelName = types_1.recase(this.options.caseModel, t, this.options.singularize);
            modelNames.push(modelName);
            str += `  ${fileName}: ${modelName}.init(sequelize, Sequelize),\n`;
        });
        str += `};\n\n`;
        str += `Object.values(models)\n`;
        str += `  .filter((model) => typeof model.associate === 'function')\n`;
        str += `  .forEach((model) => model.associate(models));\n\n`;
        str += `const db = {\n`;
        str += `  ...models,\n`;
        str += `  sequelize,\n`;
        str += `};\n\n`;
        str += `module.exports = db;\n`;
        return str;
    }
}
exports.AutoWriter = AutoWriter;
//# sourceMappingURL=auto-writer.js.map