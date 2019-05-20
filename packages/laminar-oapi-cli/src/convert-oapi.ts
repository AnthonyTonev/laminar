import { Type } from '@ovotech/ts-compose';
import {
  OpenAPIObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
} from 'openapi3-ts';
import * as ts from 'typescript';
import { convertSchema } from './convert-schema';
import { AstContext, result, Result, withEntry, withImports, withRef } from './traverse';

type Method = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
const methodNames: Method[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

interface AstParameters {
  in: {
    query?: ts.TypeElement[];
    header?: ts.TypeElement[];
    path?: ts.TypeElement[];
    cookie?: ts.TypeElement[];
  };
  context: AstContext;
}

const title = (str: string) => str.replace(/^./, first => first.toUpperCase());
const cleanIdentifierName = (str: string) => str.replace(/[^0-9a-zA-Z_$]+/g, '');

const pathToIdentifier = (path: string) =>
  path
    .split('/')
    .map(cleanIdentifierName)
    .map(title)
    .join('');

const convertParameters = (
  context: AstContext,
  parameters: Array<ParameterObject | ReferenceObject>,
) => {
  const astParams = parameters.reduce<AstParameters>(
    (node, paramOrRef) => {
      const param = withRef(paramOrRef, node.context);
      const paramNode = param.schema
        ? convertSchema(node.context, param.schema)
        : result(node.context, Type.Any);
      const params = node.in[param.in] || [];
      return {
        context: paramNode.context,
        in: {
          ...node.in,
          [param.in]: [
            ...params,
            Type.Prop({ name: param.name, type: paramNode.type, isOptional: !param.required }),
          ],
        },
      };
    },
    { in: {}, context },
  );

  return {
    type: Type.TypeLiteral({
      props: Object.entries(astParams.in).map(([name, items]) =>
        Type.Prop({ name, type: Type.TypeLiteral({ props: items! }) }),
      ),
    }),

    context: astParams.context,
  };
};

const convertResponse = (context: AstContext, key: string, response: ResponseObject) => {
  if (
    response.content &&
    response.content['application/json'] &&
    response.content['application/json'].schema
  ) {
    const node = convertSchema(context, response.content['application/json'].schema);
    const nodeType =
      key === '200'
        ? Type.Union([
            node.type,
            Type.Ref('LaminarResponse', [Type.Literal(Number(key)), node.type]),
          ])
        : key === 'default'
        ? Type.Union([node.type, Type.Ref('LaminarResponse', [Type.Any, node.type])])
        : Type.Ref('LaminarResponse', [Type.Literal(Number(key)), node.type]);

    return result(withImports(node.context, '@ovotech/laminar', ['LaminarResponse']), nodeType);
  } else {
    return null;
  }
};

const convertResponses = (context: AstContext, name: string, responses: ResponsesObject) => {
  const responseEntries = Object.entries<ResponseObject | ReferenceObject>(responses);

  const params = responseEntries.reduce<Result<ts.UnionTypeNode>>(
    (responseNode, [key, responseOrRef]) => {
      const response = withRef(responseOrRef, responseNode.context);
      const node = convertResponse(responseNode.context, key, response);

      return node
        ? result(node.context, Type.Union(responseNode.type.types.concat([node.type])))
        : responseNode;
    },
    result(context, Type.Union([])),
  );

  return params.type.types.length
    ? result(
        withEntry(params.context, Type.Alias({ name, type: params.type, isExport: true })),
        Type.Ref(name),
      )
    : result(
        withImports(context, '@ovotech/laminar', ['ResolverResponse']),
        Type.Ref('ResolverResponse'),
      );
};

const convertRequestBody = (
  context: AstContext,
  requestBodyOrRef: RequestBodyObject | ReferenceObject,
) => {
  const requestBody = withRef(requestBodyOrRef, context);
  const schema = requestBody.content['application/json']
    ? requestBody.content['application/json'].schema
    : {};
  const node = schema ? convertSchema(context, schema) : result(context, Type.Any);
  return result(
    node.context,
    Type.TypeLiteral({
      props: [Type.Prop({ name: 'body', type: node.type, isOptional: !requestBody.required })],
    }),
  );
};

export const convertOapi = (context: AstContext, api: OpenAPIObject) =>
  Object.entries<PathItemObject>(api.paths).reduce<Result<ts.TypeAliasDeclaration>>(
    (pathsNode, [path, pathApiOrRef]) => {
      const pathApi = withRef(pathApiOrRef, context);

      const methods = methodNames.reduce<Result<ts.TypeLiteralNode>>((methodsNode, method) => {
        const operation = pathApi[method];
        if (operation) {
          const astParams = operation.parameters
            ? convertParameters(methodsNode.context, operation.parameters)
            : result(methodsNode.context, Type.TypeLiteral());

          const astRequestBody = operation.requestBody
            ? convertRequestBody(astParams.context, operation.requestBody)
            : result(methodsNode.context, Type.TypeLiteral());

          const identifier = pathToIdentifier(path) + title(method);
          const contextIdentifier = identifier + 'Context';
          const responseIdentifier = identifier + 'Response';
          const contextInterface = Type.Interface({
            name: contextIdentifier,
            isExport: true,
            ext: [{ name: 'Context' }, { name: 'RouteContext' }],
            props: astParams.type.members.concat(astRequestBody.type.members),
          });

          const responseAst = convertResponses(
            astRequestBody.context,
            responseIdentifier,
            operation.responses,
          );

          const methodCall = Type.Arrow(
            [
              Type.Param({
                name: 'context',
                type: Type.Intersection([Type.Ref(contextIdentifier), Type.Ref('TContext')]),
              }),
            ],
            responseAst.type,
          );

          const methodSignature = Type.Prop({
            name: method,
            type: methodCall,
            jsDoc: operation.description,
          });

          return result(
            withEntry(responseAst.context, contextInterface),
            Type.TypeLiteral({ props: methodsNode.type.members.concat([methodSignature]) }),
          );
        } else {
          return methodsNode;
        }
      }, result(pathsNode.context, Type.TypeLiteral()));

      return result(
        methods.context,
        Type.Alias({
          isExport: true,
          name: pathsNode.type.name,
          typeArgs: [...pathsNode.type.typeParameters!],
          type: Type.TypeLiteral({
            props: (pathsNode.type.type as ts.TypeLiteralNode).members.concat([
              Type.Prop({ name: Type.LiteralString(path), type: methods.type }),
            ]),
          }),
        }),
      );
    },
    result(
      withImports(context, '@ovotech/laminar', ['Context', 'RouteContext']),
      Type.Alias({
        name: 'LaminarPaths',
        isExport: true,
        type: Type.TypeLiteral({ props: [] }),
        typeArgs: [
          Type.TypeArg({
            name: 'TContext',
            defaultType: Type.TypeLiteral(),
          }),
        ],
      }),
    ),
  );