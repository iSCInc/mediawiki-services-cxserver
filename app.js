'use strict';

require( 'core-js/shim' );

var http = require( 'http' ),
	BBPromise = require( 'bluebird' ),
	express = require( 'express' ),
	compression = require( 'compression' ),
	bodyParser = require( 'body-parser' ),
	fs = BBPromise.promisifyAll( require( 'fs' ) ),
	sUtil = require( './utils/util' ),
	apiUtil = require( './utils/api-util' ),
	packageInfo = require( './package.json' ),
	path = require( 'path' ),
	yaml = require( 'js-yaml' );

/**
 * Creates an express app and initialises it
 *
 * @param {Object} options the options to initialise the app with
 * @return {bluebird} the promise resolving to the app object
 */
function initApp( options ) {
	var app = express();

	// get the options and make them available in the app
	app.logger = options.logger; // the logging device
	app.metrics = options.metrics; // the metrics
	app.conf = options.config; // this app's config options
	app.info = packageInfo; // this app's package info
	// ensure some sane defaults
	if ( !app.conf.port ) {
		app.conf.port = 8888;
	}
	if ( !app.conf.interface ) {
		app.conf.interface = '0.0.0.0';
	}
	if ( app.conf.compression_level === undefined ) {
		app.conf.compression_level = 3;
	}
	if ( app.conf.cors === undefined ) {
		app.conf.cors = '*';
	}
	if ( app.conf.csp === undefined ) {
		app.conf.csp =
			'default-src \'self\'; object-src \'none\'; media-src *; img-src *; style-src *; frame-ancestors \'self\'';
	}

	// set outgoing proxy
	if ( app.conf.proxy ) {
		process.env.HTTP_PROXY = app.conf.proxy;
		// if there is a list of domains which should
		// not be proxied, set it
		if ( app.conf.no_proxy_list ) {
			if ( Array.isArray( app.conf.no_proxy_list ) ) {
				process.env.NO_PROXY = app.conf.no_proxy_list.join( ',' );
			} else {
				process.env.NO_PROXY = app.conf.no_proxy_list;
			}
		}
	}

	// set up the request templates for the APIs
	apiUtil.setupApiTemplates( app );

	// set up the spec
	if ( !app.conf.spec ) {
		app.conf.spec = __dirname + '/spec.yaml';
	}

	if ( app.conf.spec.constructor !== Object ) {
		try {
			app.conf.spec = yaml.safeLoad( fs.readFileSync( app.conf.spec ) );
		} catch ( e ) {
			app.logger.log( 'warn/spec', 'Could not load the spec: ' + e );
			app.conf.spec = {};
		}
	}

	// set up the registry
	if ( !app.conf.registry ) {
		app.conf.registry = __dirname + '/registry.yaml';
	} else if ( typeof app.conf.registry === 'string' ) {
		if ( !path.isAbsolute( app.conf.registry ) ) {
			app.conf.registry = __dirname + '/' + app.conf.registry;
		}
	}

	if ( app.conf.registry.constructor !== Object ) {
		try {
			app.logger.log( 'info/registry', 'Reading registry from: ' + app.conf.registry );
			app.conf.registry = yaml.safeLoad( fs.readFileSync( app.conf.registry ) );
		} catch ( e ) {
			app.logger.log( 'warn/registry', 'Could not load the registry: ' + e );
			app.conf.registry = {};
		}
	}
	if ( !app.conf.spec.swagger ) {
		app.conf.spec.swagger = '2.0';
	}
	if ( !app.conf.spec.info ) {
		app.conf.spec.info = {
			version: app.info.version,
			title: app.info.name,
			description: app.info.description
		};
	}
	app.conf.spec.info.version = app.info.version;
	if ( !app.conf.spec.paths ) {
		app.conf.spec.paths = {};
	}

	// set the CORS and CSP headers.
	app.all( '*', function ( req, res, next ) {
		if ( app.conf.cors !== false ) {
			res.header( 'access-control-allow-origin', app.conf.cors );
			res.header( 'access-control-allow-headers', 'accept, authorization, x-requested-with, content-type' );
			res.header( 'access-control-expose-headers', 'etag' );
		}
		if ( app.conf.csp !== false ) {
			res.header( 'x-xss-protection', '1; mode=block' );
			res.header( 'x-content-type-options', 'nosniff' );
			res.header( 'x-frame-options', 'SAMEORIGIN' );
			res.header( 'content-security-policy', app.conf.csp );
			res.header( 'x-content-security-policy', app.conf.csp );
			res.header( 'x-webkit-csp', app.conf.csp );
		}

		sUtil.initAndLogRequest( req, app );

		next();
	} );

	// disable the X-Powered-By header
	app.set( 'x-powered-by', false );
	// disable the ETag header.Yet to identify a valid need for cxserver.
	app.set( 'etag', false );
	// enable compression
	app.use( compression( {
		level: app.conf.compression_level
	} ) );
	// use the application/x-www-form-urlencoded parser
	app.use( bodyParser.urlencoded( {
		extended: true
	} ) );
	// use the JSON body parser
	app.use( bodyParser.json( {
		limit: 50000
	} ) );
	return BBPromise.resolve( app );
}

/**
 * Loads all routes declared in routes/ into the app
 *
 * @param {Application} app the application object to load routes into
 * @return {bluebird} a promise resolving to the app object
 */
function loadRoutes( app ) {
	// get the list of files in routes/
	return fs.readdirAsync( __dirname + '/routes' )
		.map( function ( fname ) {
			var route;

			return BBPromise.try( function () {
				// ... and then load each route
				// but only if it's a js file
				if ( !/\.js$/.test( fname ) ) {
					return undefined;
				}
				// import the route file
				route = require( __dirname + '/routes/' + fname );
				return route( app );
			} ).then( function ( route ) {
				if ( route === undefined ) {
					return undefined;
				}
				// check that the route exports the object we need
				if ( route.constructor !== Object || !route.path || !route.router || !( route.api_version || route.skip_domain ) ) {
					throw new TypeError( 'routes/' + fname + ' does not export the correct object!' );
				}
				// normalise the path to be used as the mount point
				if ( route.path[ 0 ] !== '/' ) {
					route.path = '/' + route.path;
				}
				if ( route.path[ route.path.length - 1 ] !== '/' ) {
					route.path = route.path + '/';
				}
				if ( !route.skip_domain ) {
					route.path = '/:domain/v' + route.api_version + route.path;
				}
				// wrap the route handlers with Promise.try() blocks
				sUtil.wrapRouteHandlers( route, app );
				// all good, use that route
				app.use( route.path, route.router );
			} );
		} ).then( function () {
			// Catch and handle propagated errors
			sUtil.setErrorHandler( app );
			// route loading is now complete, return the app object
			return BBPromise.resolve( app );
		} );
}

/**
 * Creates and starts the service's web server
 *
 * @param {Application} app the app object to use in the service
 * @return {bluebird} a promise creating the web server
 */
function createServer( app ) {
	// return a promise which creates an HTTP server,
	// attaches the app to it, and starts accepting
	// incoming client requests
	var server;
	return new BBPromise( function ( resolve ) {
		server = http.createServer( app ).listen(
			app.conf.port,
			app.conf.interface,
			resolve
		);
	} ).then( function () {
		app.logger.log( 'info',
			'Worker ' + process.pid + ' listening on ' +
			( app.conf.interface || '*' ) + ':' + app.conf.port );
		return server;
	} );
}

/**
 * The service's entry point. It takes over the configuration
 * options and the logger and metrics-reporting objects from
 * service-runner and starts an HTTP server, attaching the application
 * object to it.
 */
module.exports = function ( options ) {
	return initApp( options )
		.then( loadRoutes )
		.then( createServer );
};
