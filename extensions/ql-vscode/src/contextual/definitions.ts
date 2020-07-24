import * as fs from 'fs-extra';
import * as yaml from 'js-yaml';
import * as tmp from 'tmp-promise';
import * as vscode from 'vscode';
import * as path from 'path';

import { decodeSourceArchiveUri, zipArchiveScheme } from '../archive-filesystem-provider';
import { ColumnKindCode, EntityValue, getResultSetSchema } from '../bqrs-cli-types';
import { CodeQLCliServer } from '../cli';
import { DatabaseItem, DatabaseManager } from '../databases';
import * as helpers from '../helpers';
import { CachedOperation } from '../helpers';
import * as messages from '../messages';
import { QueryServerClient } from '../queryserver-client';
import { compileAndRunQueryAgainstDatabase, QueryWithResults } from '../run-queries';
import AstBuilder from './astBuilder';
import fileRangeFromURI from './fileRangeFromURI';

/**
 * Run templated CodeQL queries to find definitions and references in
 * source-language files. We may eventually want to find a way to
 * generalize this to other custom queries, e.g. showing dataflow to
 * or from a selected identifier.
 */

const TEMPLATE_NAME = 'selectedSourceFile';
const SELECT_QUERY_NAME = '#select';

enum KeyType {
  DefinitionQuery = 'DefinitionQuery',
  ReferenceQuery = 'ReferenceQuery',
  PrintAstQuery = 'PrintAstQuery',
}

function tagOfKeyType(keyType: KeyType): string {
  switch (keyType) {
    case KeyType.DefinitionQuery:
      return 'ide-contextual-queries/local-definitions';
    case KeyType.ReferenceQuery:
      return 'ide-contextual-queries/local-references';
    case KeyType.PrintAstQuery:
      return 'ide-contextual-queries/print-ast';
  }
}

function nameOfKeyType(keyType: KeyType): string {
  switch (keyType) {
    case KeyType.DefinitionQuery:
      return 'definitions';
    case KeyType.ReferenceQuery:
      return 'references';
    case KeyType.PrintAstQuery:
      return 'print AST';
  }
}

function kindOfKeyType(keyType: KeyType): string {
  switch (keyType) {
    case KeyType.DefinitionQuery:
    case KeyType.ReferenceQuery:
      return 'definitions';
    case KeyType.PrintAstQuery:
      return 'graph';
  }
}

async function resolveQueries(cli: CodeQLCliServer, qlpack: string, keyType: KeyType): Promise<string[]> {
  const suiteFile = (await tmp.file({
    postfix: '.qls'
  })).path;
  const suiteYaml = { qlpack, include: { kind: kindOfKeyType(keyType), 'tags contain': tagOfKeyType(keyType) } };
  await fs.writeFile(suiteFile, yaml.safeDump(suiteYaml), 'utf8');

  const queries = await cli.resolveQueriesInSuite(suiteFile, helpers.getOnDiskWorkspaceFolders());
  if (queries.length === 0) {
    vscode.window.showErrorMessage(
      `No ${nameOfKeyType(keyType)} queries (tagged "${tagOfKeyType(keyType)}") could be found in the current library path. It might be necessary to upgrade the CodeQL libraries.`
    );
    throw new Error(`Couldn't find any queries tagged ${tagOfKeyType(keyType)} for qlpack ${qlpack}`);
  }
  return queries;
}

async function qlpackOfDatabase(cli: CodeQLCliServer, db: DatabaseItem): Promise<string | undefined> {
  if (db.contents === undefined)
    return undefined;
  const datasetPath = db.contents.datasetUri.fsPath;
  const { qlpack } = await helpers.resolveDatasetFolder(cli, datasetPath);
  return qlpack;
}

interface FullLocationLink extends vscode.LocationLink {
  originUri: vscode.Uri;
}

export class TemplateQueryDefinitionProvider implements vscode.DefinitionProvider {
  private cache: CachedOperation<vscode.LocationLink[]>;

  constructor(
    private cli: CodeQLCliServer,
    private qs: QueryServerClient,
    private dbm: DatabaseManager,
  ) {
    this.cache = new CachedOperation<vscode.LocationLink[]>(this.getDefinitions.bind(this));
  }

  async provideDefinition(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken): Promise<vscode.LocationLink[]> {
    const fileLinks = await this.cache.get(document.uri.toString());
    const locLinks: vscode.LocationLink[] = [];
    for (const link of fileLinks) {
      if (link.originSelectionRange!.contains(position)) {
        locLinks.push(link);
      }
    }
    return locLinks;
  }

  private async getDefinitions(uriString: string): Promise<vscode.LocationLink[]> {
    return getLinksForUriString(
      this.cli,
      this.qs,
      this.dbm,
      uriString,
      KeyType.DefinitionQuery,
      (src, _dest) => src === uriString
    );
  }
}

export class TemplateQueryReferenceProvider implements vscode.ReferenceProvider {
  private cache: CachedOperation<FullLocationLink[]>;

  constructor(
    private cli: CodeQLCliServer,
    private qs: QueryServerClient,
    private dbm: DatabaseManager,
  ) {
    this.cache = new CachedOperation<FullLocationLink[]>(this.getReferences.bind(this));
  }

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.Location[]> {
    const fileLinks = await this.cache.get(document.uri.toString());
    const locLinks: vscode.Location[] = [];
    for (const link of fileLinks) {
      if (link.targetRange!.contains(position)) {
        locLinks.push({ range: link.originSelectionRange!, uri: link.originUri });
      }
    }
    return locLinks;
  }

  private async getReferences(uriString: string): Promise<FullLocationLink[]> {
    return getLinksForUriString(
      this.cli,
      this.qs,
      this.dbm,
      uriString,
      KeyType.ReferenceQuery,
      (_src, dest) => dest === uriString
    );
  }
}

export class TemplatePrintAstProvider {
  private cache: CachedOperation<QueryWithResults | undefined>;

  constructor(
    private cli: CodeQLCliServer,
    private qs: QueryServerClient,
    private dbm: DatabaseManager,
  ) {
    this.cache = new CachedOperation<QueryWithResults | undefined>(this.getAst.bind(this));
  }

  async provideAst(document?: vscode.TextDocument): Promise<AstBuilder | undefined> {
    if (!document) {
      return;
    }
    const queryResults = await this.cache.get(document.uri.toString());
    if (!queryResults) {
      return;
    }

    return new AstBuilder(
      queryResults, this.cli,
      this.dbm.findDatabaseItem(vscode.Uri.parse(queryResults.database.databaseUri!))!,
      path.basename(document.fileName)
    );
  }

  private async getAst(uriString: string): Promise<QueryWithResults> {
    const uri = vscode.Uri.parse(uriString, true);
    if (uri.scheme !== zipArchiveScheme) {
      throw new Error('AST Viewing is only available for databases with zipped source archives.');
    }

    const zippedArchive = decodeSourceArchiveUri(uri);
    const sourceArchiveUri = vscode.Uri.file(zippedArchive.sourceArchiveZipPath).with({ scheme: zipArchiveScheme });
    const db = this.dbm.findDatabaseItemBySourceArchive(sourceArchiveUri);

    if (!db) {
      throw new Error('Can\'t infer database from the provided source.');
    }

    const qlpack = await qlpackOfDatabase(this.cli, db);
    if (!qlpack) {
      throw new Error('Can\'t infer qlpack from database source archive');
    }
    const queries = await resolveQueries(this.cli, qlpack, KeyType.PrintAstQuery);
    if (queries.length > 1) {
      throw new Error('Found multiple Print AST queries. Can\'t continue');
    }
    if (queries.length === 0) {
      throw new Error('Did not find any Print AST queries. Can\'t continue');
    }

    const query = queries[0];
    const templates: messages.TemplateDefinitions = {
      [TEMPLATE_NAME]: {
        values: {
          tuples: [[{
            stringValue: zippedArchive.pathWithinSourceArchive
          }]]
        }
      }
    };
    return await compileAndRunQueryAgainstDatabase(
      this.cli,
      this.qs,
      db,
      false,
      vscode.Uri.file(query),
      templates
    );
  }
}

async function getLinksFromResults(
  results: QueryWithResults,
  cli: CodeQLCliServer,
  db: DatabaseItem,
  filter: (srcFile: string, destFile: string) => boolean
): Promise<FullLocationLink[]> {
  const localLinks: FullLocationLink[] = [];
  const bqrsPath = results.query.resultsPaths.resultsPath;
  const info = await cli.bqrsInfo(bqrsPath);
  const selectInfo = getResultSetSchema(SELECT_QUERY_NAME, info);
  if (selectInfo && selectInfo.columns.length == 3
    && selectInfo.columns[0].kind == ColumnKindCode.ENTITY
    && selectInfo.columns[1].kind == ColumnKindCode.ENTITY
    && selectInfo.columns[2].kind == ColumnKindCode.STRING) {
    // TODO: Page this
    const allTuples = await cli.bqrsDecode(bqrsPath, SELECT_QUERY_NAME);
    for (const tuple of allTuples.tuples) {
      const [src, dest] = tuple as [EntityValue, EntityValue];
      const srcFile = src.url && fileRangeFromURI(src.url, db);
      const destFile = dest.url && fileRangeFromURI(dest.url, db);
      if (srcFile && destFile && filter(srcFile.uri.toString(), destFile.uri.toString())) {
        localLinks.push({
          targetRange: destFile.range,
          targetUri: destFile.uri,
          originSelectionRange: srcFile.range,
          originUri: srcFile.uri
        });
      }
    }
  }
  return localLinks;
}

async function getLinksForUriString(
  cli: CodeQLCliServer,
  qs: QueryServerClient,
  dbm: DatabaseManager,
  uriString: string,
  keyType: KeyType,
  filter: (src: string, dest: string) => boolean
) {
  const uri = decodeSourceArchiveUri(vscode.Uri.parse(uriString));
  const sourceArchiveUri = vscode.Uri.file(uri.sourceArchiveZipPath).with({ scheme: zipArchiveScheme });

  const db = dbm.findDatabaseItemBySourceArchive(sourceArchiveUri);
  if (db) {
    const qlpack = await qlpackOfDatabase(cli, db);
    if (qlpack === undefined) {
      throw new Error('Can\'t infer qlpack from database source archive');
    }
    const links: FullLocationLink[] = [];
    for (const query of await resolveQueries(cli, qlpack, keyType)) {
      const templates: messages.TemplateDefinitions = {
        [TEMPLATE_NAME]: {
          values: {
            tuples: [[{
              stringValue: uri.pathWithinSourceArchive
            }]]
          }
        }
      };
      const results = await compileAndRunQueryAgainstDatabase(cli, qs, db, false, vscode.Uri.file(query), templates);
      if (results.result.resultType == messages.QueryResultType.SUCCESS) {
        links.push(...await getLinksFromResults(results, cli, db, filter));
      }
    }
    return links;
  } else {
    return [];
  }
}