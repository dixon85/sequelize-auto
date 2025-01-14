import _ from 'lodash';
import { Utils } from 'sequelize';
import { ColumnDescription } from 'sequelize/types';
import { DialectOptions, FKSpec } from './dialects/dialect-options';
import {
  AutoOptions,
  CaseOption,
  Field,
  IndexSpec,
  LangOption,
  qNameJoin,
  qNameSplit,
  recase,
  Relation,
  TableData,
  TSField,
  singularize,
  pluralize,
} from './types';

/** Generates text from each table in TableData */
export class AutoGenerator {
  dialect: DialectOptions;
  tables: { [tableName: string]: { [fieldName: string]: ColumnDescription } };
  foreignKeys: { [tableName: string]: { [fieldName: string]: FKSpec } };
  hasTriggerTables: { [tableName: string]: boolean };
  indexes: { [tableName: string]: IndexSpec[] };
  relations: Relation[];
  space: string[];
  options: {
    indentation?: number;
    spaces?: boolean;
    lang?: LangOption;
    noAlias?: boolean;
    caseModel?: CaseOption;
    caseProp?: CaseOption;
    caseFile?: CaseOption;
    additional?: any;
    schema?: string;
    singularize: boolean;
  };

  constructor(tableData: TableData, dialect: DialectOptions, options: AutoOptions) {
    this.tables = tableData.tables;
    this.foreignKeys = tableData.foreignKeys;
    this.hasTriggerTables = tableData.hasTriggerTables;
    this.indexes = tableData.indexes;
    this.relations = tableData.relations;
    this.dialect = dialect;
    this.options = options;
    this.options.lang = this.options.lang || 'es5';

    // build the space array of indentation strings
    let sp = '';
    for (let x = 0; x < (this.options.indentation || 2); ++x) {
      sp += this.options.spaces === true ? ' ' : '\t';
    }
    this.space = [];
    for (let i = 0; i < 6; i++) {
      this.space[i] = sp.repeat(i);
    }
  }

  makeHeaderTemplate() {
    let header = '';
    const sp = this.space[1];

    if (this.options.lang === 'ts') {
      header += "import * as Sequelize from 'sequelize';\n";
      header += "import { DataTypes, Model, Optional } from 'sequelize';\n";
    } else if (this.options.lang === 'es6') {
      header += "const Sequelize = require('sequelize');\n";
      header += 'module.exports = (sequelize, DataTypes) => {\n';
      header += sp + 'return #TABLE#.init(sequelize, DataTypes);\n';
      header += '}\n\n';
      header += 'class #TABLE# extends Sequelize.Model {\n';
      header += sp + 'static init(sequelize, DataTypes) {\n';
      header += sp + 'super.init({\n';
    } else if (this.options.lang === 'esm') {
      header += "import _sequelize from 'sequelize';\n";
      header += 'const { Model, Sequelize } = _sequelize;\n\n';
      header += 'export default class #TABLE# extends Model {\n';
      header += sp + 'static init(sequelize, DataTypes) {\n';
      header += sp + 'super.init({\n';
    } else if (this.options.lang === 'custom') {
      header += "import { Model } from 'sequelize';\n\n";
      header += 'export default class #TABLE# extends Model {\n';
      header += sp + 'static init(sequelize, DataTypes) {\n';
      header += sp + sp + 'super.init(\n';
      header += sp + sp + sp + '{\n';
    } else {
      header += "const Sequelize = require('sequelize');\n";
      header += 'module.exports = function(sequelize, DataTypes) {\n';
      header += sp + "return sequelize.define('#TABLE#', {\n";
    }
    return header;
  }

  generateText() {
    const tableNames = _.keys(this.tables);

    const header = this.makeHeaderTemplate();

    const text: { [name: string]: string } = {};
    tableNames.forEach((table) => {
      let str = header;
      const [schemaName, tableNameOrig] = qNameSplit(table);
      const tableName = recase(this.options.caseModel, tableNameOrig, this.options.singularize);

      if (this.options.lang === 'ts') {
        const associations = this.addTypeScriptAssociationMixins(table);
        const needed = _.keys(associations.needed).sort();
        needed.forEach((fkTable) => {
          const set = associations.needed[fkTable];
          const [fkSchema, fkTableName] = qNameSplit(fkTable);
          const filename = recase(this.options.caseFile, fkTableName, this.options.singularize);
          str += 'import type { ';
          str += Array.from(set.values()).sort().join(', ');
          str += ` } from './${filename}';\n`;
        });

        str += '\nexport interface #TABLE#Attributes {\n';
        str += this.addTypeScriptFields(table, true) + '}\n\n';

        const primaryKeys = this.getTypeScriptPrimaryKeys(table);

        if (primaryKeys.length) {
          str += `export type #TABLE#Pk = ${primaryKeys
            .map((k) => `"${recase(this.options.caseProp, k)}"`)
            .join(' | ')};\n`;
          str += `export type #TABLE#Id = #TABLE#[#TABLE#Pk];\n`;
          str += 'export type #TABLE#CreationAttributes = Optional<#TABLE#Attributes, #TABLE#Pk>;\n\n';
        } else {
          str += 'export type #TABLE#CreationAttributes = #TABLE#Attributes;\n\n';
        }

        str +=
          'export class #TABLE# extends Model<#TABLE#Attributes, #TABLE#CreationAttributes> implements #TABLE#Attributes {\n';
        str += this.addTypeScriptFields(table, false);
        str += '\n' + associations.str;
        str += '\n' + this.space[1] + 'static initModel(sequelize: Sequelize.Sequelize): typeof ' + tableName + ' {\n';
        str += this.space[2] + tableName + '.init({\n';
      }

      str += this.addTable(table);

      const re = new RegExp('#TABLE#', 'g');
      str = str.replace(re, tableName);

      text[table] = str;
    });

    return text;
  }

  /** Create the belongsToMany/belongsTo/hasMany/hasOne association strings */
  private addAssociations(typeScript: boolean, model: string) {
    let strBelongs = '';
    let strBelongsToMany = '';
    let str = '  static associate(models) {\n';
    let strEnd = '  }\n';

    console.log('Model:' + model);
    const rels = this.relations;
    rels.forEach((rel) => {
      if (rel.isM2M && rel.parentModel === model) {
        const asprop = pluralize(rel.childProp);
        strBelongsToMany += `    this.belongsToMany(models.${recase(
          this.options.caseProp,
          rel.childModel
        )}, {\n      through: '${recase(
          //)}, {\n      as: '${asprop}',\n      through: '${recase(
          this.options.caseProp,
          rel.joinModel
        )}',\n      foreignKey: '${rel.parentId}',\n      otherKey: '${rel.childId}',\n    });\n`;
      } else {
        // check if M2M exists
        let existsM2M: boolean = false;

        rels.find((relation) => {
          if (
            relation.isM2M === true &&
            relation.parentModel === rel.parentModel &&
            relation.childModel === rel.childModel
          ) {
            console.log(`A Duplicate relation between '${relation.childModel}' and '${rel.childModel}' found`);
            existsM2M = true;
          }
        });

        if (rel.childModel === model && existsM2M === false) {
          const bAlias =
            this.options.noAlias && rel.parentModel.toLowerCase() === rel.parentProp.toLowerCase()
              ? ''
              : `as: '${rel.parentProp}', `;
          strBelongs += `    this.belongsTo(models.${recase(
            this.options.caseProp,
            rel.parentModel
          )}, { ${bAlias}foreignKey: '${rel.parentId}' });\n`;
        }

        existsM2M = false;

        rels.find((relation) => {
          if (relation.isM2M === true && relation.joinModel === rel.childModel) {
            console.log(`A Duplicate join relation between '${relation.joinModel}' and '${rel.childModel}' found`);
            existsM2M = true;
          }
        });

        if (rel.parentModel === model && existsM2M === false) {
          const hasRel = rel.isOne ? 'hasOne' : 'hasMany';
          const hAlias =
            this.options.noAlias && Utils.pluralize(rel.childModel.toLowerCase()) === rel.childProp.toLowerCase()
              ? ''
              : `as: '${rel.childProp}', `;
          strBelongs += `    this.${hasRel}(models.${recase(
            this.options.caseProp,
            rel.childModel
          )}, { ${hAlias}foreignKey: '${rel.parentId}' });\n`;
        }
      }
    });

    // belongsToMany must come first
    return str + strBelongsToMany + strBelongs + strEnd;
  }

  // Create a string for the model of the table
  private addTable(table: string) {
    const [schemaName, tableNameOrig] = qNameSplit(table);
    const tableName = recase(this.options.caseModel, tableNameOrig, this.options.singularize);
    const space = this.space;
    let timestamps = (this.options.additional && this.options.additional.timestamps === true) || false;
    let paranoid = false;

    // add all the fields
    let str = '';
    const fields = _.keys(this.tables[table]);
    fields.forEach((field, index) => {
      timestamps ||= this.isTimestampField(field);
      paranoid ||= this.isParanoidField(field);

      str += this.addField(table, field);
    });

    // trim off last ",\n"
    //str = str.substring(0, str.length - 2) + '\n';

    // add the table options
    str += space[3] + '},\n';
    str += space[3] + '{\n';
    str += space[4] + 'sequelize,\n';

    // Changed 'tableName' to 'modelName'
    str += space[4] + "modelName: '" + tableNameOrig + "',\n";

    if (schemaName && this.dialect.hasSchema) {
      str += space[4] + "schema: '" + schemaName + "',\n";
    }

    if (this.hasTriggerTables[table]) {
      str += space[4] + 'hasTrigger: true,\n';
    }

    if (timestamps === false) {
      str += space[4] + 'timestamps: ' + timestamps + ',\n';
    }

    if (paranoid) {
      str += space[4] + 'paranoid: true,\n';
    }

    // conditionally add additional options
    const hasadditional = _.isObject(this.options.additional) && _.keys(this.options.additional).length > 0;
    if (hasadditional) {
      _.each(this.options.additional, (value, key) => {
        if (key === 'name') {
          // name: true - preserve table name always
          str += space[4] + 'name: {\n';
          str += space[5] + "singular: '" + table + "',\n";
          str += space[5] + "plural: '" + table + "'\n";
          str += space[4] + '},\n';
        } else if (key === 'timestamps' || key === 'paranoid') {
          // handled above
        } else {
          value = _.isBoolean(value) ? value : "'" + value + "'";
          str += space[4] + key + ': ' + value + ',\n';
        }
      });
    }

    // add indexes
    str += this.addIndexes(table);

    str = space[4] + str.trim();
    // str = str.substring(0, str.length - 1);
    str += '\n' + space[3] + '}\n';

    str += space[2] + ');\n';
    const lang = this.options.lang;
    if (lang === 'es6' || lang === 'esm' || lang === 'ts' || lang === 'custom') {
      str += space[2] + 'return ' + tableName + ';\n';
      str += space[1] + '}\n\n';
      str += this.addAssociations(false, tableName);
      str += '}\n';
    } else {
      str += '};\n';
    }
    return str;
  }

  // Create a string containing field attributes (type, defaultValue, etc.)
  private addField(table: string, field: string): string {
    // ignore Sequelize standard fields
    const additional = this.options.additional;
    if (
      additional &&
      additional.timestamps !== false &&
      (this.isTimestampField(field) || this.isParanoidField(field))
    ) {
      return '';
    }

    // Find foreign key
    const foreignKey =
      this.foreignKeys[table] && this.foreignKeys[table][field] ? this.foreignKeys[table][field] : null;
    const fieldObj = this.tables[table][field] as Field;

    if (_.isObject(foreignKey)) {
      fieldObj.foreignKey = foreignKey;
    }

    const fieldName = recase(this.options.caseProp, field);
    let str = this.quoteName(fieldName) + ': {\n';

    const quoteWrapper = `'`;

    const unique = fieldObj.unique || (fieldObj.foreignKey && fieldObj.foreignKey.isUnique);

    const isSerialKey =
      (fieldObj.foreignKey && fieldObj.foreignKey.isSerialKey) ||
      (this.dialect.isSerialKey && this.dialect.isSerialKey(fieldObj));

    let wroteAutoIncrement = false;
    const space = this.space;

    // column's attributes
    const fieldAttrs = _.keys(fieldObj);
    let validationStr: string = '';

    fieldAttrs.forEach((attr) => {
      // We don't need the special attribute from postgresql; "unique" is handled separately
      if (attr === 'special' || attr === 'elementType' || attr === 'unique') {
        return true;
      }

      if (isSerialKey && !wroteAutoIncrement) {
        str += space[5] + 'autoIncrement: true,\n';
        // Resort to Postgres' GENERATED BY DEFAULT AS IDENTITY instead of SERIAL
        if (
          this.dialect.name === 'postgres' &&
          fieldObj.foreignKey &&
          fieldObj.foreignKey.isPrimaryKey === true &&
          (fieldObj.foreignKey.generation === 'ALWAYS' || fieldObj.foreignKey.generation === 'BY DEFAULT')
        ) {
          str += space[5] + 'autoIncrementIdentity: true,\n';
        }
        wroteAutoIncrement = true;
      }

      if (attr === 'foreignKey') {
        if (foreignKey && foreignKey.isForeignKey) {
          str += space[5] + 'references: {\n';
          str += space[3] + space[3] + "model: '" + fieldObj[attr].foreignSources.target_table + "',\n";
          str += space[3] + space[3] + "key: '" + fieldObj[attr].foreignSources.target_column + "',\n";
          str += space[5] + '}';
        } else {
          return true;
        }
      } else if (attr === 'references') {
        // covered by foreignKey
        return true;
      } else if (attr === 'primaryKey') {
        if (fieldObj[attr] === true && (!_.has(fieldObj, 'foreignKey') || !!fieldObj.foreignKey.isPrimaryKey)) {
          str += space[5] + 'primaryKey: true';
        } else {
          return true;
        }
      } else if (attr === 'autoIncrement') {
        if (fieldObj[attr] === true && !wroteAutoIncrement) {
          str += space[5] + 'autoIncrement: true,\n';
          // Resort to Postgres' GENERATED BY DEFAULT AS IDENTITY instead of SERIAL
          if (
            this.dialect.name === 'postgres' &&
            fieldObj.foreignKey &&
            fieldObj.foreignKey.isPrimaryKey === true &&
            (fieldObj.foreignKey.generation === 'ALWAYS' || fieldObj.foreignKey.generation === 'BY DEFAULT')
          ) {
            str += space[5] + 'autoIncrementIdentity: true,\n';
          }
          wroteAutoIncrement = true;
        }
        return true;
      } else if (attr === 'allowNull') {
        str += space[5] + attr + ': ' + fieldObj[attr];
        if (fieldObj[attr] === false) {
          validationStr += `${this.space[3]}${this.space[3]}notNull: {\n`;
          validationStr += `${this.space[3]}${this.space[3]}${this.space[1]}msg: '"${fieldName}" cannot be empty.',\n`;
          validationStr += `${this.space[3]}${this.space[3]}},\n`;
        }
      } else if (attr === 'defaultValue') {
        let defaultVal = fieldObj.defaultValue;
        if (this.dialect.name === 'mssql' && defaultVal && defaultVal.toLowerCase() === '(newid())') {
          defaultVal = null as any; // disable adding "default value" attribute for UUID fields if generating for MS SQL
        }
        if (
          this.dialect.name === 'mssql' &&
          (['(NULL)', 'NULL'].includes(defaultVal) || typeof defaultVal === 'undefined')
        ) {
          defaultVal = null as any; // Override default NULL in MS SQL to javascript null
        }

        if (defaultVal === null || defaultVal === undefined) {
          return true;
        }
        if (isSerialKey) {
          return true; // value generated in the database
        }

        let val_text = defaultVal;
        if (_.isString(defaultVal)) {
          const field_type = fieldObj.type.toLowerCase();
          defaultVal = this.escapeSpecial(defaultVal);

          if (field_type === 'bit(1)' || field_type === 'bit' || field_type === 'boolean') {
            // convert string to boolean
            val_text = /1|true/i.test(defaultVal) ? 'true' : 'false';
          } else if (this.isArray(field_type)) {
            // remove outer {}
            val_text = defaultVal.replace(/^{/, '').replace(/}$/, '');
            if (val_text && this.isString(fieldObj.elementType)) {
              // quote the array elements
              val_text = val_text
                .split(',')
                .map((s) => `"${s}"`)
                .join(',');
            }
            val_text = `[${val_text}]`;
          } else if (this.isNumber(field_type) || field_type.match(/^(json)/)) {
            // remove () around mssql numeric values; don't quote numbers or json
            val_text = defaultVal.replace(/[)(]/g, '');
          } else if (
            field_type === 'uuid' &&
            (defaultVal === 'gen_random_uuid()' || defaultVal === 'uuid_generate_v4()')
          ) {
            val_text = 'DataTypes.UUIDV4';
          } else if (_.endsWith(defaultVal, '()') || _.endsWith(defaultVal, '())')) {
            // wrap default value function
            val_text = "Sequelize.Sequelize.fn('" + defaultVal.replace(/[)(]/g, '') + "')";
          } else if (field_type.indexOf('date') === 0 || field_type.indexOf('timestamp') === 0) {
            if (
              _.includes(
                ['current_timestamp', 'current_date', 'current_time', 'localtime', 'localtimestamp'],
                defaultVal.toLowerCase()
              )
            ) {
              val_text = "Sequelize.Sequelize.literal('" + defaultVal + "')";
            } else {
              val_text = quoteWrapper + defaultVal + quoteWrapper;
            }
          } else {
            val_text = quoteWrapper + defaultVal + quoteWrapper;
          }
        }

        // val_text = _.isString(val_text) && !val_text.match(/^sequelize\.[^(]+\(.*\)$/)
        // ? self.sequelize.escape(_.trim(val_text, '"'), null, self.options.dialect)
        // : val_text;
        // don't prepend N for MSSQL when building models...
        // defaultVal = _.trimStart(defaultVal, 'N');

        str += space[5] + attr + ': ' + val_text;
      } else if (attr === 'comment' && !fieldObj[attr]) {
        return true;
      } else {
        let val = attr !== 'type' ? null : this.getSqType(fieldObj, attr);
        if (val == null) {
          val = (fieldObj as any)[attr];
          val = _.isString(val) ? quoteWrapper + this.escapeSpecial(val) + quoteWrapper : val;
        }
        str += space[5] + attr + ': ' + val;
        validationStr += this.getFieldValidation(fieldObj, attr, fieldName);
      }

      str += ',\n';
    });

    if (unique) {
      const uniq = _.isString(unique) ? quoteWrapper + unique.replace(/\"/g, '\\"') + quoteWrapper : unique;
      str += space[5] + 'unique: ' + uniq + ',\n';
    }

    if (field !== fieldName) {
      // write the original fieldname, unless it is a key and the column names are case-insensitive
      // because Sequelize may request the same column twice in a join condition otherwise.
      if (!fieldObj.primaryKey || this.dialect.canAliasPK || field.toUpperCase() !== fieldName.toUpperCase()) {
        str += space[5] + "field: '" + field + "',\n";
      }
    }

    if (validationStr.length > 0) {
      str += space[5] + 'validate: {\n';
      str += validationStr;
      str += space[5] + '},\n';
    }
    // removes the last `,` within the attribute options
    // str = str.trim().replace(/,+$/, '') + '\n';
    str = space[4] + str + space[4] + '},\n';
    return str;
  }

  private addIndexes(table: string) {
    const indexes = this.indexes[table];
    const space = this.space;
    let str = '';
    if (indexes && indexes.length) {
      str += space[4] + 'indexes: [\n';
      indexes.forEach((idx) => {
        str += space[5] + '{\n';
        if (idx.name) {
          str += space[3] + space[3] + `name: '${idx.name}',\n`;
        }
        if (idx.unique) {
          str += space[3] + space[3] + 'unique: true,\n';
        }
        if (idx.type) {
          if (['UNIQUE', 'FULLTEXT', 'SPATIAL'].includes(idx.type)) {
            str += space[3] + space[3] + `type: '${idx.type}',\n`;
          } else {
            str += space[3] + space[3] + `using: '${idx.type}',\n`;
          }
        }
        str += space[3] + space[3] + `fields: [`;
        idx.fields.forEach((ff) => {
          str += `{ name: '${ff.attribute}'`;
          if (ff.collate) {
            str += `, collate: '${ff.collate}'`;
          }
          if (ff.length) {
            str += `, length: ${ff.length}`;
          }
          if (ff.order && ff.order !== 'ASC') {
            str += `, order: '${ff.order}'`;
          }
          str += ' }, ';
        });
        str = str.slice(0, str.length - 2);
        str += '],\n';
        str += space[5] + '},\n';
      });
      str += space[4] + '],\n';
    }
    return str;
  }

  /** Get the sequelize type from the Field */
  private getSqType(fieldObj: Field, attr: string): string {
    const attrValue = (fieldObj as any)[attr];
    if (!attrValue.toLowerCase) {
      console.log('attrValue', attr, attrValue);
      return attrValue;
    }
    const type: string = attrValue.toLowerCase();
    const length = type.match(/\(\d+\)/);
    const precision = type.match(/\(\d+,\d+\)/);
    let val = null;
    let typematch = null;

    if (type === 'boolean' || type === 'bit(1)' || type === 'bit' || type === 'tinyint(1)') {
      val = 'DataTypes.BOOLEAN';

      // postgres range types
    } else if (type === 'numrange') {
      val = 'DataTypes.RANGE(DataTypes.DECIMAL)';
    } else if (type === 'int4range') {
      val = 'DataTypes.RANGE(DataTypes.INTEGER)';
    } else if (type === 'int8range') {
      val = 'DataTypes.RANGE(DataTypes.BIGINT)';
    } else if (type === 'daterange') {
      val = 'DataTypes.RANGE(DataTypes.DATEONLY)';
    } else if (type === 'tsrange' || type === 'tstzrange') {
      val = 'DataTypes.RANGE(DataTypes.DATE)';
    } else if ((typematch = type.match(/^(bigint|smallint|mediumint|tinyint|int)/))) {
      // integer subtypes
      val = 'DataTypes.' + (typematch[0] === 'int' ? 'INTEGER' : typematch[0].toUpperCase());
      if (/unsigned/i.test(type)) {
        val += '.UNSIGNED';
      }
      if (/zerofill/i.test(type)) {
        val += '.ZEROFILL';
      }
    } else if (type === 'nvarchar(max)' || type === 'varchar(max)') {
      val = 'DataTypes.TEXT';
    } else if (type.match(/n?varchar|string|varying/)) {
      val = 'DataTypes.STRING' + (!_.isNull(length) ? length : '');
    } else if (type.match(/^n?char/)) {
      val = 'DataTypes.CHAR' + (!_.isNull(length) ? length : '');
    } else if (type.match(/^real/)) {
      val = 'DataTypes.REAL';
    } else if (type.match(/text$/)) {
      val = 'DataTypes.TEXT' + (!_.isNull(length) ? length : '');
    } else if (type === 'date') {
      val = 'DataTypes.DATEONLY';
    } else if (type.match(/^(date|timestamp)/)) {
      val = 'DataTypes.DATE' + (!_.isNull(length) ? length : '');
    } else if (type.match(/^(time)/)) {
      val = 'DataTypes.TIME';
    } else if (type.match(/^(float|float4)/)) {
      val = 'DataTypes.FLOAT' + (!_.isNull(precision) ? precision : '');
    } else if (type.match(/^(decimal|numeric)/)) {
      val = 'DataTypes.DECIMAL' + (!_.isNull(precision) ? precision : '');
    } else if (type.match(/^money/)) {
      val = 'DataTypes.DECIMAL(19,4)';
    } else if (type.match(/^smallmoney/)) {
      val = 'DataTypes.DECIMAL(10,4)';
    } else if (type.match(/^(float8|double)/)) {
      val = 'DataTypes.DOUBLE' + (!_.isNull(precision) ? precision : '');
    } else if (type.match(/^uuid|uniqueidentifier/)) {
      val = 'DataTypes.UUID';
    } else if (type.match(/^jsonb/)) {
      val = 'DataTypes.JSONB';
    } else if (type.match(/^json/)) {
      val = 'DataTypes.JSON';
    } else if (type.match(/^geometry/)) {
      const gtype = fieldObj.elementType ? `(${fieldObj.elementType})` : '';
      val = `DataTypes.GEOMETRY${gtype}`;
    } else if (type.match(/^geography/)) {
      const gtype = fieldObj.elementType ? `(${fieldObj.elementType})` : '';
      val = `DataTypes.GEOGRAPHY${gtype}`;
    } else if (type.match(/^array/)) {
      const eltype = this.getSqType(fieldObj, 'elementType');
      val = `DataTypes.ARRAY(${eltype})`;
    } else if (type.match(/(binary|image|blob)/)) {
      val = 'DataTypes.BLOB';
    } else if (type.match(/^hstore/)) {
      val = 'DataTypes.HSTORE';
    } else if (type.match(/^enum(\(.*\))?$/)) {
      const enumValues = this.getEnumValues(fieldObj);
      val = `DataTypes.ENUM(${enumValues})`;
    }

    return val as string;
  }

  private getTypeScriptPrimaryKeys(table: string): Array<string> {
    const fields = _.keys(this.tables[table]);
    return fields.filter((field): boolean => {
      const fieldObj = this.tables[table][field];
      return fieldObj['primaryKey'];
    });
  }

  /** Get the sequelize type from the Field */
  private getFieldValidation(fieldObj: Field, attr: string, fieldName: string): string {
    const attrValue = (fieldObj as any)[attr];
    if (!attrValue.toLowerCase) {
      console.log('attrValue', attr, attrValue);
      return attrValue;
    }
    const type: string = attrValue.toLowerCase();
    const length = type.match(/\d+/);
    const precision = type.match(/\(\d+,\d+\)/);
    let val = null;
    let typematch = null;

    if (type === 'boolean' || type === 'bit(1)' || type === 'bit' || type === 'tinyint(1)' || type === 'tinyint') {
      val = '';

      // postgres range types
    } else if (type === 'numrange') {
      val = '';
    } else if (type === 'int4range') {
      val = '';
    } else if (type === 'int8range') {
      val = '';
    } else if (type === 'daterange') {
      val = '';
    } else if (type === 'tsrange' || type === 'tstzrange') {
      val = '';
    } else if ((typematch = type.match(/^(bigint|smallint|mediumint|tinyint|int)/))) {
      if (/unsigned/i.test(type)) {
        val = `${this.space[3]}${this.space[3]}isInt: {\n`;
        val += `${this.space[3]}${this.space[3]}${this.space[1]}msg: '"${fieldName}" must be an integer.',\n`;
        val += `${this.space[3]}${this.space[3]}},\n`;
      } else {
        val = `${this.space[3]}${this.space[3]}isDecimal: {\n`;
        val += `${this.space[3]}${this.space[3]}${this.space[1]}msg: '"${fieldName}" must be decimal.',\n`;
        val += `${this.space[3]}${this.space[3]}},\n`;
      }
    } else if (type === 'nvarchar(max)' || type === 'varchar(max)') {
      val = '';
    } else if (type.match(/n?varchar|string|varying/)) {
      val = `${this.space[3]}${this.space[3]}len: {\n`;

      const isISO = fieldName.startsWith('iso');

      if (isISO === true) {
        val += `${this.space[3]}${this.space[3]}${this.space[1]}args: [${length}, ${length}],\n`;
        val += `${this.space[3]}${this.space[3]}${this.space[1]}msg: '"${fieldName}" must be exactly ${length} characters.',\n`;
        val += `${this.space[3]}${this.space[3]}},\n`;
        val += `${this.space[3]}${this.space[3]}isAlpha: {\n`;
        val += `${this.space[3]}${this.space[3]}${this.space[1]}msg: '"${fieldName}" must contain letters only.',\n`;
        val += `${this.space[3]}${this.space[3]}},\n`;
      } else {
        val += `${this.space[3]}${this.space[3]}${this.space[1]}args: [1, ${length}],\n`;
        val += `${this.space[3]}${this.space[3]}${this.space[1]}msg: '"${fieldName}" must be no more than ${length} characters in length.',\n`;
        val += `${this.space[3]}${this.space[3]}},\n`;
      }
    } else if (type.match(/^n?char/)) {
      val = '';
    } else if (type.match(/^real/)) {
      val = '';
    } else if (type.match(/text$/)) {
      val = '';
    } else if (type === 'date') {
      val = `${this.space[3]}${this.space[3]}isDate: {\n`;
      val += `${this.space[3]}${this.space[3]}${this.space[1]}msg: '"${fieldName}" must be a date-only string in the format YYYY-MM-DD.',\n`;
      val += `${this.space[3]}${this.space[3]}},\n`;
    } else if (type.match(/^(date|timestamp)/)) {
      val = `${this.space[3]}${this.space[3]}isDate: {\n`;
      val += `${this.space[3]}${this.space[3]}${this.space[1]}msg: '"${fieldName}" must be a date in the format YYYY-MM-DD 00:00:00.',\n`;
      val += `${this.space[3]}${this.space[3]}},\n`;
    } else if (type.match(/^(time)/)) {
      val = '';
    } else if (type.match(/^(float|float4)/)) {
      val = '';
    } else if (type.match(/^(decimal|numeric)/)) {
      val = '';
    } else if (type.match(/^money/)) {
      val = '';
    } else if (type.match(/^smallmoney/)) {
      val = '';
    } else if (type.match(/^(float8|double)/)) {
      val = '';
    } else if (type.match(/^uuid|uniqueidentifier/)) {
      val = '';
    } else if (type.match(/^jsonb/)) {
      val = '';
    } else if (type.match(/^json/)) {
      val = '';
    } else if (type.match(/^geometry/)) {
      val = ``;
    } else if (type.match(/^geography/)) {
      val = ``;
    } else if (type.match(/^array/)) {
      val = ``;
    } else if (type.match(/(binary|image|blob)/)) {
      val = '';
    } else if (type.match(/^hstore/)) {
      val = '';
    } else if (type.match(/^enum(\(.*\))?$/)) {
      val = ``;
    }

    return val as string;
  }

  /** Add schema to table so it will match the relation data.  Fixes mysql problem. */
  private addSchemaForRelations(table: string) {
    if (!table.includes('.') && !this.relations.some((rel) => rel.childTable === table)) {
      // if no tables match the given table, then assume we need to fix the schema
      const first = this.relations.find((rel) => !!rel.childTable);
      if (first) {
        const [schemaName, tableName] = qNameSplit(first.childTable);
        if (schemaName) {
          table = qNameJoin(schemaName, table);
        }
      }
    }
    return table;
  }

  private addTypeScriptAssociationMixins(table: string): Record<string, any> {
    const sp = this.space[3];
    const needed: Record<string, Set<String>> = {};
    let str = '';

    table = this.addSchemaForRelations(table);

    this.relations.forEach((rel) => {
      if (!rel.isM2M) {
        if (rel.childTable === table) {
          // current table is a child that belongsTo parent
          const pparent = _.upperFirst(rel.parentProp);
          str += `${sp}// ${rel.childModel} belongsTo ${rel.parentModel} via ${rel.parentId}\n`;
          str += `${sp}${rel.parentProp}!: ${rel.parentModel};\n`;
          str += `${sp}get${pparent}!: Sequelize.BelongsToGetAssociationMixin<${rel.parentModel}>;\n`;
          str += `${sp}set${pparent}!: Sequelize.BelongsToSetAssociationMixin<${rel.parentModel}, ${rel.parentModel}Id>;\n`;
          str += `${sp}create${pparent}!: Sequelize.BelongsToCreateAssociationMixin<${rel.parentModel}>;\n`;
          needed[rel.parentTable] ??= new Set();
          needed[rel.parentTable].add(rel.parentModel);
          needed[rel.parentTable].add(rel.parentModel + 'Id');
        } else if (rel.parentTable === table) {
          needed[rel.childTable] ??= new Set();
          const pchild = _.upperFirst(rel.childProp);
          if (rel.isOne) {
            // const hasModelSingular = singularize(hasModel);
            str += `${sp}// ${rel.parentModel} hasOne ${rel.childModel} via ${rel.parentId}\n`;
            str += `${sp}${rel.childProp}!: ${rel.childModel};\n`;
            str += `${sp}get${pchild}!: Sequelize.HasOneGetAssociationMixin<${rel.childModel}>;\n`;
            str += `${sp}set${pchild}!: Sequelize.HasOneSetAssociationMixin<${rel.childModel}, ${rel.childModel}Id>;\n`;
            str += `${sp}create${pchild}!: Sequelize.HasOneCreateAssociationMixin<${rel.childModel}CreationAttributes>;\n`;
            needed[rel.childTable].add(rel.childModel);
            needed[rel.childTable].add(`${rel.childModel}Id`);
            needed[rel.childTable].add(`${rel.childModel}CreationAttributes`);
          } else {
            const hasModel = rel.childModel;
            const sing = _.upperFirst(singularize(rel.childProp));
            const lur = pluralize(rel.childProp);
            const plur = _.upperFirst(lur);
            str += `${sp}// ${rel.parentModel} hasMany ${rel.childModel} via ${rel.parentId}\n`;
            str += `${sp}${lur}!: ${rel.childModel}[];\n`;
            str += `${sp}get${plur}!: Sequelize.HasManyGetAssociationsMixin<${hasModel}>;\n`;
            str += `${sp}set${plur}!: Sequelize.HasManySetAssociationsMixin<${hasModel}, ${hasModel}Id>;\n`;
            str += `${sp}add${sing}!: Sequelize.HasManyAddAssociationMixin<${hasModel}, ${hasModel}Id>;\n`;
            str += `${sp}add${plur}!: Sequelize.HasManyAddAssociationsMixin<${hasModel}, ${hasModel}Id>;\n`;
            str += `${sp}create${sing}!: Sequelize.HasManyCreateAssociationMixin<${hasModel}>;\n`;
            str += `${sp}remove${sing}!: Sequelize.HasManyRemoveAssociationMixin<${hasModel}, ${hasModel}Id>;\n`;
            str += `${sp}remove${plur}!: Sequelize.HasManyRemoveAssociationsMixin<${hasModel}, ${hasModel}Id>;\n`;
            str += `${sp}has${sing}!: Sequelize.HasManyHasAssociationMixin<${hasModel}, ${hasModel}Id>;\n`;
            str += `${sp}has${plur}!: Sequelize.HasManyHasAssociationsMixin<${hasModel}, ${hasModel}Id>;\n`;
            str += `${sp}count${plur}!: Sequelize.HasManyCountAssociationsMixin;\n`;
            needed[rel.childTable].add(hasModel);
            needed[rel.childTable].add(`${hasModel}Id`);
          }
        }
      } else {
        // rel.isM2M
        if (rel.parentTable === table) {
          // many-to-many
          const isParent = rel.parentTable === table;
          const thisModel = isParent ? rel.parentModel : rel.childModel;
          const otherModel = isParent ? rel.childModel : rel.parentModel;
          const otherModelSingular = _.upperFirst(singularize(isParent ? rel.childProp : rel.parentProp));
          const lotherModelPlural = pluralize(isParent ? rel.childProp : rel.parentProp);
          const otherModelPlural = _.upperFirst(lotherModelPlural);
          const otherTable = isParent ? rel.childTable : rel.parentTable;
          str += `${sp}// ${thisModel} belongsToMany ${otherModel} via ${rel.parentId} and ${rel.childId}\n`;
          str += `${sp}${lotherModelPlural}!: ${otherModel}[];\n`;
          str += `${sp}get${otherModelPlural}!: Sequelize.BelongsToManyGetAssociationsMixin<${otherModel}>;\n`;
          str += `${sp}set${otherModelPlural}!: Sequelize.BelongsToManySetAssociationsMixin<${otherModel}, ${otherModel}Id>;\n`;
          str += `${sp}add${otherModelSingular}!: Sequelize.BelongsToManyAddAssociationMixin<${otherModel}, ${otherModel}Id>;\n`;
          str += `${sp}add${otherModelPlural}!: Sequelize.BelongsToManyAddAssociationsMixin<${otherModel}, ${otherModel}Id>;\n`;
          str += `${sp}create${otherModelSingular}!: Sequelize.BelongsToManyCreateAssociationMixin<${otherModel}>;\n`;
          str += `${sp}remove${otherModelSingular}!: Sequelize.BelongsToManyRemoveAssociationMixin<${otherModel}, ${otherModel}Id>;\n`;
          str += `${sp}remove${otherModelPlural}!: Sequelize.BelongsToManyRemoveAssociationsMixin<${otherModel}, ${otherModel}Id>;\n`;
          str += `${sp}has${otherModelSingular}!: Sequelize.BelongsToManyHasAssociationMixin<${otherModel}, ${otherModel}Id>;\n`;
          str += `${sp}has${otherModelPlural}!: Sequelize.BelongsToManyHasAssociationsMixin<${otherModel}, ${otherModel}Id>;\n`;
          str += `${sp}count${otherModelPlural}!: Sequelize.BelongsToManyCountAssociationsMixin;\n`;
          needed[otherTable] ??= new Set();
          needed[otherTable].add(otherModel);
          needed[otherTable].add(`${otherModel}Id`);
        }
      }
    });
    if (needed[table]) {
      delete needed[table]; // don't add import for self
    }
    return { needed, str };
  }

  private addTypeScriptFields(table: string, isInterface: boolean) {
    const sp = this.space[2];
    const fields = _.keys(this.tables[table]);
    const notNull = isInterface ? '' : '!';
    let str = '';
    fields.forEach((field) => {
      const name = this.quoteName(recase(this.options.caseProp, field));
      const isOptional = this.getTypeScriptFieldOptional(table, field);
      str += `${sp}${name}${isOptional ? '?' : notNull}: ${this.getTypeScriptType(table, field)};\n`;
    });
    return str;
  }

  private getTypeScriptFieldOptional(table: string, field: string) {
    const fieldObj = this.tables[table][field];
    return fieldObj.allowNull || fieldObj.defaultValue || fieldObj.defaultValue === '';
  }

  private getTypeScriptType(table: string, field: string) {
    const fieldObj = this.tables[table][field] as TSField;
    return this.getTypeScriptFieldType(fieldObj, 'type');
  }

  private getTypeScriptFieldType(fieldObj: TSField, attr: keyof TSField) {
    const rawFieldType = fieldObj[attr] || '';
    const fieldType = String(rawFieldType).toLowerCase();

    let jsType: string;

    if (this.isArray(fieldType)) {
      const eltype = this.getTypeScriptFieldType(fieldObj, 'elementType');
      jsType = eltype + '[]';
    } else if (this.isNumber(fieldType)) {
      jsType = 'number';
    } else if (this.isBoolean(fieldType)) {
      jsType = 'boolean';
    } else if (this.isDate(fieldType)) {
      jsType = 'Date';
    } else if (this.isString(fieldType)) {
      jsType = 'string';
    } else if (this.isEnum(fieldType)) {
      const values = this.getEnumValues(fieldObj);
      jsType = values.join(' | ');
    } else {
      console.log(`Missing TypeScript type: ${fieldType || fieldObj['type']}`);
      jsType = 'any';
    }
    return jsType;
  }

  private getEnumValues(fieldObj: TSField): string[] {
    if (fieldObj.special) {
      // postgres
      return fieldObj.special.map((v) => `"${v}"`);
    } else {
      // mysql
      return fieldObj.type.substring(5, fieldObj.type.length - 1).split(',');
    }
  }

  private isTimestampField(field: string) {
    const additional = this.options.additional;
    if (additional.timestamps === false) {
      return false;
    }
    return (
      (!additional.createdAt && field.toLowerCase() === 'createdat') ||
      additional.createdAt === field ||
      (!additional.updatedAt && field.toLowerCase() === 'updatedat') ||
      additional.updatedAt === field
    );
  }

  private isParanoidField(field: string) {
    const additional = this.options.additional;
    if (additional.timestamps === false || additional.paranoid === false) {
      return false;
    }
    return (!additional.deletedAt && field.toLowerCase() === 'deletedat') || additional.deletedAt === field;
  }

  private escapeSpecial(val: string) {
    if (typeof val !== 'string') {
      return val;
    }
    return val
      .replace(/[\\]/g, '\\\\')
      .replace(/[\"]/g, '\\"')
      .replace(/[\/]/g, '\\/')
      .replace(/[\b]/g, '\\b')
      .replace(/[\f]/g, '\\f')
      .replace(/[\n]/g, '\\n')
      .replace(/[\r]/g, '\\r')
      .replace(/[\t]/g, '\\t');
  }

  /** Quote the name if it is not a valid identifier */
  private quoteName(name: string) {
    return /^[$A-Z_][0-9A-Z_$]*$/i.test(name) ? name : "'" + name + "'";
  }

  private isNumber(fieldType: string): boolean {
    return /^(smallint|mediumint|tinyint|int|bigint|float|money|smallmoney|double|decimal|numeric|real)/.test(
      fieldType
    );
  }

  private isBoolean(fieldType: string): boolean {
    return /^(boolean|bit)/.test(fieldType);
  }

  private isDate(fieldType: string): boolean {
    return /^(datetime|timestamp)/.test(fieldType);
  }

  private isString(fieldType: string): boolean {
    return /^(char|nchar|string|varying|varchar|nvarchar|text|longtext|mediumtext|tinytext|ntext|uuid|uniqueidentifier|date|time)/.test(
      fieldType
    );
  }

  private isArray(fieldType: string): boolean {
    return /(^array)|(range$)/.test(fieldType);
  }

  private isEnum(fieldType: string): boolean {
    return /^(enum)/.test(fieldType);
  }
}
