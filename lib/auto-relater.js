"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoRelater = void 0;
const lodash_1 = __importDefault(require("lodash"));
const types_1 = require("./types");
/** Constructs entity relationships from TableData.foreignKeys and populates TableData.relations */
class AutoRelater {
    constructor(options) {
        this.caseModel = options.caseModel || 'o';
        this.caseProp = options.caseProp || 'o';
        this.singularize = options.singularize;
        this.relations = [];
        this.usedChildNames = new Set();
    }
    /** Create Relations from the foreign keys, and add to TableData */
    buildRelations(td) {
        const fkTables = lodash_1.default.keys(td.foreignKeys).sort();
        fkTables.forEach((t) => {
            const fkFields = td.foreignKeys[t];
            const fkFieldNames = lodash_1.default.keys(fkFields);
            fkFieldNames.forEach((fkFieldName) => {
                const spec = fkFields[fkFieldName];
                if (spec.isForeignKey) {
                    this.addRelation(t, fkFieldName, spec, fkFields);
                }
            });
        });
        td.relations = lodash_1.default.sortBy(this.relations, ['parentTable', 'childTable']);
        return td;
    }
    /** Create a Relation object for the given foreign key */
    addRelation(table, fkFieldName, spec, fkFields) {
        const [schemaName, tableName] = types_1.qNameSplit(table);
        const schema = schemaName;
        const modelName = types_1.recase(this.caseModel, tableName, this.singularize);
        const targetModel = types_1.recase(this.caseModel, spec.foreignSources.target_table, this.singularize);
        const alias = this.getAlias(fkFieldName, spec.foreignSources.target_table, spec.foreignSources.source_table);
        const childAlias = this.getChildAlias(fkFieldName, spec.foreignSources.source_table, spec.foreignSources.target_table);
        const sourceProp = types_1.recase(this.caseProp, fkFieldName);
        // use "hasOne" cardinality if this FK is also a single-column Primary or Unique key; else "hasMany"
        const isOne = (spec.isPrimaryKey && !lodash_1.default.some(fkFields, (f) => f.isPrimaryKey && f.source_column !== fkFieldName)) ||
            (!!spec.isUnique && !lodash_1.default.some(fkFields, (f) => f.isUnique === spec.isUnique && f.source_column !== fkFieldName));
        this.relations.push({
            parentId: sourceProp,
            parentModel: targetModel,
            parentProp: alias,
            parentTable: types_1.qNameJoin(spec.foreignSources.target_schema || schema, spec.foreignSources.target_table),
            childModel: modelName,
            childProp: isOne ? types_1.singularize(childAlias) : types_1.pluralize(childAlias),
            childTable: types_1.qNameJoin(spec.foreignSources.source_schema || schema, spec.foreignSources.source_table),
            isOne: isOne,
            isM2M: false,
        });
        if (spec.isPrimaryKey) {
            // if FK is also part of the PK, see if there is a "many-to-many" junction
            const otherKeys = lodash_1.default.filter(fkFields, (k) => k.isForeignKey && k.isPrimaryKey && k.source_column !== fkFieldName);
            if (otherKeys.length === 1) {
                const otherKey = otherKeys[0];
                const otherModel = types_1.recase(this.caseModel, otherKey.foreignSources.target_table, this.singularize);
                const otherProp = this.getAlias(otherKey.source_column, otherKey.foreignSources.target_table, otherKey.foreignSources.source_table, true);
                const otherId = types_1.recase(this.caseProp, otherKey.source_column);
                this.relations.push({
                    parentId: sourceProp,
                    parentModel: targetModel,
                    parentProp: types_1.pluralize(alias),
                    parentTable: types_1.qNameJoin(spec.foreignSources.target_schema || schema, spec.foreignSources.target_table),
                    childModel: otherModel,
                    childProp: types_1.pluralize(otherProp),
                    childTable: types_1.qNameJoin(otherKey.foreignSources.target_schema || schema, otherKey.foreignSources.target_table),
                    childId: otherId,
                    joinModel: modelName,
                    isOne: isOne,
                    isM2M: true,
                });
            }
        }
    }
    /** Convert foreign key name into alias name for belongsTo relations */
    getAlias(fkFieldName, modelName, targetModel, isM2M = false) {
        let name = this.trimId(fkFieldName);
        if (name === fkFieldName || isM2M) {
            name = fkFieldName + '_' + modelName;
        }
        if (isM2M) {
            if (this.usedChildNames.has(modelName + '.' + name)) {
                name = name + '_' + targetModel;
            }
            this.usedChildNames.add(modelName + '.' + name);
        }
        else {
            this.usedChildNames.add(targetModel + '.' + name);
        }
        return types_1.recase(this.caseProp, name, true);
    }
    /** Convert foreign key name into alias name for hasMany/hasOne relations */
    getChildAlias(fkFieldName, modelName, targetModel) {
        let name = modelName;
        // usedChildNames prevents duplicate names in same model
        if (this.usedChildNames.has(targetModel + '.' + name)) {
            name = this.trimId(fkFieldName);
            name = name + '_' + modelName;
        }
        this.usedChildNames.add(targetModel + '.' + name);
        return types_1.recase(this.caseProp, name, true);
    }
    trimId(name) {
        if (name.length > 3 && name.toLowerCase().endsWith('id')) {
            name = name.substring(0, name.length - 2);
        }
        if (name.endsWith('_')) {
            name = name.substring(0, name.length - 1);
        }
        return name;
    }
}
exports.AutoRelater = AutoRelater;
//# sourceMappingURL=auto-relater.js.map