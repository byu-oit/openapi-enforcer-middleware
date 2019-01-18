/**
 *  @license
 *    Copyright 2019 Brigham Young University
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 **/
'use strict'
const Debug = require('debug')
const Enforcer = require('openapi-enforcer')
const path = require('path')

const debug = {
  controllers: Debug('openapi-enforcer-middleware:controllers'),
  mock: Debug('openapi-enforcer-middleware:mock'),
  request: Debug('openapi-enforcer-middleware:request'),
  response: Debug('openapi-enforcer-middleware:response')
}
const ENFORCER_HEADER = 'x-openapi-enforcer'

module.exports = OpenApiEnforcerMiddleware

function OpenApiEnforcerMiddleware (definition, options) {
  if (!(this instanceof OpenApiEnforcerMiddleware)) return new OpenApiEnforcerMiddleware(definition, options)

  // validate and normalize options
  if (options !== undefined && (!options || typeof options !== 'object')) throw Error('Invalid option specified. Expected an object. Received: ' + options)
  if (!options) options = {}

  // get general settings
  const general = {
    fallthrough: options.hasOwnProperty('fallthrough') ? options.fallthrough : true,
    middleware: [],
    mockHeader: options.mockHeader || 'x-mock',
    mockQuery: options.mockQuery || 'x-mock',
    reqMockStatusCodeProperty: options.reqMockStatusCodeProperty || 'mockStatusCode',
    reqOpenApiProperty: options.reqOpenApiProperty || 'openapi',
    reqOperationProperty: options.reqOperationProperty || 'operation',
    xController: options.xController || 'x-controller',
    xOperation: options.xOperation || 'x-operation'
  }

  // validate general settings and store them
  if (typeof general.mockHeader !== 'string') throw Error('Configuration option "mockHeader" must be a string. Received: ' + general.mockHeader)
  if (typeof general.mockQuery !== 'string') throw Error('Configuration option "mockQuery" must be a string. Received: ' + general.mockQuery)
  if (typeof general.reqMockStatusCodeProperty !== 'string') throw Error('Configuration option "reqMockStatusCodeProperty" must be a string. Received: ' + general.reqMockStatusCodeProperty)
  if (typeof general.reqOpenApiProperty !== 'string') throw Error('Configuration option "reqOpenApiProperty" must be a string. Received: ' + general.reqOpenApiProperty)
  if (typeof general.reqOperationProperty !== 'string') throw Error('Configuration option "reqOperationProperty" must be a string. Received: ' + general.reqOperationProperty)
  if (typeof general.xController !== 'string') throw Error('Configuration option "xController" must be a string. Received: ' + general.xController)
  if (typeof general.xOperation !== 'string') throw Error('Configuration option "xOperation" must be a string. Received: ' + general.xOperation)
  this.options = general

  // wait for the definition to be built
  this.promise = Enforcer(definition, { fullResult: true })
    .then(result => {
      const [ openapi, exception, warning ] = result
      if (exception) throw Error(exception.toString())
      if (warning) console.warn(warning)
      return openapi
    })
}

OpenApiEnforcerMiddleware.prototype.controllers = function (controllersTarget, ...dependencyInjection) {
  const promise = this.promise
    .then(openapi => mapControllers(openapi, false, controllersTarget, dependencyInjection, this.options))

  this.use((req, res, next) => {
    promise
      .then((controllers) => {
        const operation = req[this.options.reqOperationProperty]
        const controller = controllers.get(operation)
        if (controller) {
          res.set(ENFORCER_HEADER, 'controller')
          debug.controllers('executing controller')
          controller(req, res, next)
        } else {
          next()
        }
      })
      .catch(next)
  })

  return promise
}

OpenApiEnforcerMiddleware.prototype.middleware = function () {
  const extractValue = Enforcer.v3_0.Schema.extractValue // v2 and v3 extractValue is the same
  const options = this.options
  return (req, res, _next) => {
    // store original send
    const send = res.send

    function next (err) {
      res.send = send
      if (err) return _next(err)
      _next()
    }

    this.promise
      .then(openapi => {
        // make a copy of the request to be used just within this middleware
        req = Object.assign({}, req)

        // parse, serialize, and validate request
        debug.request('validating and parsing')
        const requestObj = {
          headers: req.headers,
          method: req.method,
          path: req.originalUrl.substr(req.baseUrl.length)
        }
        if (hasBody(req)) requestObj.body = req.body
        const [ request, clientError ] = openapi.request(requestObj)

        // 404 renders this middleware useless so exit appropriately
        if (clientError && clientError.statusCode === 404) {
          if (options.fallthrough) {
            debug.request('fallthrough')
            next()
          } else {
            res.sendStatus(404)
          }
        } else {
          // overwrite the send
          res.send = function (body) {
            res.send = send

            const code = res.statusCode || 200
            const openapi = req[options.reqOpenApiProperty]
            const operation = req[options.reqOperationProperty]
            const headers = res.getHeaders()
            const v2 = openapi.hasOwnProperty('swagger')

            // if content type is not specified for openapi version >= 3 then derive it
            if (!headers['content-type'] && !v2) {
              const [ type ] = operation.getResponseContentTypeMatches(code, req.headers.accepts || '*/*')
              if (type) {
                res.set('content-type', type)
                headers['content-type'] = type
              }
            }

            const [ response, exception ] = operation.response(code, body, Object.assign({}, headers))
            if (exception) {
              res.status(500)
              return next(errorFromException(exception))
            }

            Object.keys(response.headers).forEach(header => res.set(header, extractValue(response.headers[header])))
            response.hasOwnProperty('body')
              ? res.send(extractValue(response.body))
              : res.send()
          }

          // store openapi instance with request object
          req[options.reqOpenApiProperty] = openapi

          const runner = middlewareRunner(options.middleware, true, req, res, next)
          if (clientError) {
            const [ value ] = openapi.path(requestObj.method, requestObj.path)
            req[options.reqOperationProperty] = value.operation
            runner(errorFromException(clientError))
          } else {
            // store operation instance with request
            req[options.reqOperationProperty] = request.operation

            // copy deserialized and validated parameters to the request object
            req.params = request.path || {}
            ;['cookies', 'headers', 'params', 'query'].forEach(key => { req[key] = Object.assign({}, req[key], request[key]) })
            if (request.hasOwnProperty('body')) req.body = request.body

            runner()
          }
        }
      })
      .catch(next)
  }
}

OpenApiEnforcerMiddleware.prototype.mocks = function (controllersTarget, automatic = false, ...dependencyInjection) {
  const options = this.options
  let _openapi
  const promise = this.promise
    .then(openapi => {
      _openapi = openapi
      return mapControllers(openapi, true, controllersTarget, dependencyInjection, this.options)
    })

  this.use((req, res, next) => {
    promise
      .then(controllers => {
        const operation = req[this.options.reqOperationProperty]
        const controller = controllers.get(operation)
        const responseCodes = Object.keys(operation.responses)

        // check to see if using manual mock or automatic
        const mockHeaderKey = options.mockHeader
        const mockQueryKey = options.mockQuery
        let mock
        if (req.headers.hasOwnProperty(mockHeaderKey)) {
          mock = {
            source: 'header',
            specified: req.headers[mockHeaderKey] !== '',
            statusCode: req.headers[mockHeaderKey] || responseCodes[0] || ''
          }
        } else if (req.headers.hasOwnProperty(mockQueryKey)) {
          mock = {
            source: 'query',
            specified: req.headers[mockQueryKey] !== '',
            statusCode: req.headers[mockHeaderKey] || responseCodes[0] || ''
          }
        } else if (automatic) {
          mock = {
            source: 'automatic',
            specified: false,
            statusCode: responseCodes[0] || ''
          }
        }

        // if skipping mock then call next middleware
        if (!mock) {
          next()
        } else {
          const version = _openapi.swagger ? 2 : /^(\d+)/.exec(_openapi.openapi)[0]
          const exception = new Enforcer.Exception('Unable to generate mock response')
          exception.statusCode = 400

          if (operation.responses.hasOwnProperty(mock.statusCode)) mock.response = operation.responses[mock.statusCode]
          req[options.reqMockStatusCodeProperty] = mock

          // if a controller is provided then call it
          if (controller) {
            res.set(ENFORCER_HEADER, 'mock')
            debug.controllers('executing mock controller')
            try {
              controller(req, res, next)
            } catch (err) {
              next(err)
            }

            // if response code is not a listed response
          } else if (!mock.response) {
            debug.controllers('unable to generate mock for unlisted status code')
            exception.message('No response is defined for status code: ' + mock.statusCode)
            next(errorFromException(exception))
          } else {
            const response = mock.response

            // v2 mock
            if (version === 2 && response.schema) {
              const [ value, err, warning ] = response.schema.random()
              if (err) {
                exception.push(err)
                unableToMock(exception, next)
              } else if (warning) {
                exception.push(warning)
                unableToMock(exception, next)
              } else {
                res.status(mock.statusCode)
                res.send(value)
              }

              // v3 mock
            } else if (version === 3 && response.content) {
              const type = operation.getResponseContentTypeMatches(mock.statusCode, req.headers.accepts || '*/*')
              const schema = response.content[type].schema
              if (schema) {
                const [ value, err, warning ] = schema.random()
                if (err) {
                  exception.push(err)
                  unableToMock(exception, next)
                } else if (warning) {
                  exception.push(warning)
                  unableToMock(exception, next)
                } else {
                  res.status(mock.statusCode)
                  res.send(value)
                }
              } else {
                exception.message('No schema associated with response')
                unableToMock(exception, next)
              }
            } else {
              unableToMock(exception, next)
            }
          }
        }
      })
      .catch(next)
  })

  return promise
}

OpenApiEnforcerMiddleware.prototype.use = function (middleware) {
  if (typeof middleware !== 'function') throw Error('Invalid middleware. Value must be a function. Received: ' + middleware)
  this.options.middleware.push(middleware)
}

function exceptionPushError (exception, error) {
  const stack = error.stack
  if (stack) {
    const lines = stack.split(/\r\n|\r|\n/)
    const child = exception.nest(lines.shift())
    let line
    while ((line = lines.shift())) {
      child.message(line)
    }
  } else {
    exception.message(String(error))
  }
}

function errorFromException (exception) {
  const err = Error(exception.toString())
  err.exception = exception
  if (exception.hasOwnProperty('statusCode')) err.statusCode = exception.statusCode
  return err
}

function hasBody (req) {
  return req.headers['transfer-encoding'] !== undefined ||
    !isNaN(req.headers['content-length'])
}

function isNonNullObject (value) {
  return value && typeof value === 'object'
}

function mapControllers (openapi, isMock, controllersTarget, dependencyInjection, options) {
  const loadedControllers = {}
  const map = new Map()
  const xController = options.xController
  const xOperation = options.xOperation
  const rootController = openapi && openapi[xController]

  // validate input
  let controllersTargetType = typeof controllersTarget
  const mockStr = isMock ? 'mock ' : ''
  if (controllersTargetType !== 'function' && controllersTargetType !== 'string' && !isNonNullObject(controllersTarget)) {
    const exception = new Enforcer.Exception('Unable to load ' + mockStr + 'controllers')
    exception.message('Controllers target must be a string, a non-null object, or a function that returns a non-null object')
    throw Error(exception.toString())
  }

  // if the controllers target is a function then execute it
  if (controllersTargetType === 'function') {
    controllersTarget = controllersTarget.apply(undefined, dependencyInjection)
    if (!isNonNullObject(controllersTarget)) {
      const exception = new Enforcer.Exception('Unable to load ' + mockStr + 'controllers')
      exception.message('Controllers target function must return a non-null object')
      throw Error(exception.toString())
    }
  }

  const controllerTargetIsString = typeof controllersTarget === 'string'
  const exception = controllerTargetIsString
    ? new Enforcer.Exception('Unable to load one or more ' + mockStr + 'directory controllers within ' + controllersTarget)
    : new Enforcer.Exception('Unable to load one or more ' + mockStr + 'controllers')

  Object.keys(openapi.paths).forEach(pathKey => {
    const pathItem = openapi.paths[pathKey]
    const pathController = pathItem[xController]

    pathItem.methods.forEach(method => {
      const operation = pathItem && pathItem[method]
      const operationController = operation && operation[xController]
      const controllerName = operationController || pathController || rootController
      const operationName = operation && (operation[xOperation] || operation.operationId)
      if (controllerName && operationName) {
        const child = exception.at(controllerName)
        let handler

        // load controller from file path
        if (controllerTargetIsString) {
          const controllerPath = path.resolve(controllersTarget, controllerName)
          try {
            if (!loadedControllers[controllerPath]) {
              let controller = require(controllerPath)
              if (typeof controller === 'function') controller = controller.apply(controller, dependencyInjection)
              loadedControllers[controllerPath] = controller
            }
            const controller = loadedControllers[controllerPath]
            if (!controller.hasOwnProperty(operationName)) {
              child.message('Operation not found: ' + operationName)
            } else {
              handler = controller[operationName]
            }
          } catch (err) {
            if (err.code === 'MODULE_NOT_FOUND') {
              child.message('Controller file not found')
            } else {
              exceptionPushError(child, err)
            }
          }

        // load controller from object
        } else {
          if (!controllersTarget[controllerName]) {
            child.message('Controller not found')
          } else if (!controllersTarget[controllerName][operationName]) {
            child.message('Controller operation not found: ' + operationName)
          } else {
            handler = controllersTarget[controllerName] && controllersTarget[controllerName][operationName]
          }
        }

        // if a handler exists then validate and normalize it
        if (handler) {
          if (Array.isArray(handler)) {
            const middlewareArray = []
            const length = handler.length
            const grandChild = child.nest('Expected a function or an array of functions')
            for (let i = 0; i < length; i++) {
              const item = handler[i]
              if (typeof item !== 'function') {
                grandChild.at(i).message('Not a function')
              } else {
                middlewareArray.push(item)
              }
            }
            map.set(operation, function (req, res, next) {
              middlewareRunner(middlewareArray, false, req, res, next)()
            })
          } else if (typeof handler === 'function') {
            map.set(operation, handler)
          } else {
            child.message('Expected a function or an array of functions. Received: ' + handler)
          }
        }
      }
    })
  })

  if (exception.hasException) throw Error(exception.toString())
  return map
}

function middlewareRunner (store, clearEnforcerHeader, req, res, next) {
  const middlewares = store.slice(0)
  const run = err => {
    while (middlewares.length) {
      if (clearEnforcerHeader) res.removeHeader(ENFORCER_HEADER)
      const middleware = middlewares.shift()
      const isErrorHandling = middleware.length >= 4
      try {
        if (err && isErrorHandling) {
          return middleware(err, req, res, run)
        } else if (!err && !isErrorHandling) {
          return middleware(req, res, run)
        }
      } catch (e) {
        return run(e)
      }
    }
    if (clearEnforcerHeader) res.removeHeader(ENFORCER_HEADER)
    next(err)
  }
  return run
}

function unableToMock (exception, next) {
  debug.controllers('unable to generate automatic mock')
  exception.message('Unable to generate mock response')
  exception.statusCode = 501

  const err = errorFromException(exception)
  next(err)
}
