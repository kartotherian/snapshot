'use strict';

let util = require('util'),
    Promise = require('bluebird'),
    abaculus = Promise.promisify(require('abaculus'), {multiArgs: true}),
    Overlay = require('tilelive-overlay'),
    _ = require('underscore'),
    makeDomainValidator = require('domain-validator'),
    autoPosition = require('./autoPosition');

let core, Err, mapdataLoader, parseProtocol, mapnik;

module.exports = function snapshot(coreV, router) {
    core = coreV;
    Err = core.Err;

    mapnik = core.mapnik;

    let allowedDomains = core.getConfiguration().allowedDomains,
        httpsDomains = makeDomainValidator(allowedDomains ? allowedDomains.https : undefined, true),
        httpDomains = makeDomainValidator(allowedDomains ? allowedDomains.http : undefined, true);

    parseProtocol = domain => {
        if (httpsDomains.test(domain)) {
            return 'https';
        } else if (httpDomains.test(domain)) {
            return 'http';
        } else {
            throw new Err('Domain is not allowed').metrics('err.req.domain');
        }
    };

    if (allowedDomains) {
        mapdataLoader = require('./mapdataLoader');
    }

    // get static image
    // router.get('/img/:src(' + core.Sources.sourceIdReStr + '),:zoom(\\d+),:lat([-\\d\\.]+),:lon([-\\d\\.]+),:w(\\d+)x:h(\\d+).:format([\\w]+)', requestHandler);
    // router.get('/img/:src(' + core.Sources.sourceIdReStr + '),:zoom(\\d+),:lat([-\\d\\.]+),:lon([-\\d\\.]+),:w(\\d+)x:h(\\d+)@:scale([\\.\\d]+)x.:format([\\w]+)', requestHandler);
    router.get('/img/:src(' + core.Sources.sourceIdReStr + '),:zoom([\\d|auto]+),:lat([-\\d\\.|auto]+),:lon([-\\d\\.|auto]+),:w(\\d+)x:h(\\d+).:format([\\w]+)', requestHandler);
    router.get('/img/:src(' + core.Sources.sourceIdReStr + '),:zoom([\\d|auto]+),:lat([-\\d\\.|auto]+),:lon([-\\d\\.|auto]+),:w(\\d+)x:h(\\d+)@:scale([\\.\\d]+)x.:format([\\w]+)', requestHandler);
};

/**
 * Create a parameters object for Abaculus
 * @param params
 * @param tileSource
 * @return {{zoom: number, scale: number, center: {y: number, x: number, w: number, h: number}, format: string, getTile: function}}
 */
function makeParams(params, tileSource) {
    return {
        zoom: params.zoom,
        scale: params.scale,
        center: {
            y: Math.min(85, Math.max(-85, params.lat)),
            x: Math.min(180, Math.max(-180, params.lon)),
            w: params.w,
            h: params.h
        },
        format: params.format,
        getTile: tileSource.getTile.bind(tileSource)
    };
}

/**
 * Web server (express) route handler to get a snapshot image
 * @param req request object
 * @param res response object
 * @param next will be called if request is not handled
 */
function requestHandler(req, res, next) {

    let source, protocol,
        params = req && req.params,
        qparams = req && req.query,
        start = Date.now();

    return Promise.try(() => {
        source = core.getPublicSource(params.src);

        params.scale = core.validateScale(params.scale, source);

        // Overlays only support 2x scaling, so if scale is less than <1.5x, drop to 1x, otherwise - 2x
        params.scale = (!params.scale || params.scale < 1.5) ? 1 : 2;

        // Abaculus(?) doesn't position images with scale != 1
        params.scale = 1;

        if (!source.static) {
            throw new Err('Static snapshot images are not enabled for this source').metrics('err.req.static');
        }
        if (params.format !== 'png' && params.format !== 'jpeg' || !_.contains(source.formats, params.format)) {
            throw new Err('Format %s is not allowed for static images', params.format).metrics('err.req.stformat');
        }
        params.w = core.strToInt(params.w);
        params.h = core.strToInt(params.h);

        if (!core.isInteger(params.w) || !core.isInteger(params.h)) {
            throw new Err('The width and height params must be integers for static images').metrics('err.req.stsize');
        }
        if (params.w > source.maxwidth || params.h > source.maxheight) {
            throw new Err('Requested image is too big').metrics('err.req.stsizebig');
        }

        if (!qparams.domain && !qparams.title) {
            // For now returns JPEG without overlays
            params.lat = core.strToFloat(params.lat);
            params.lon = core.strToFloat(params.lon);
            params.zoom = core.validateZoom(params.zoom, source);
            if (typeof params.lat !== 'number' || typeof params.lon !== 'number') {
                throw new Err('The lat and lon coordinates must be numeric for static images').metrics('err.req.stcoords');
            }
            return abaculus(makeParams(params, source.getHandler()));
        }

        if (!mapdataLoader) {
            throw new Err('Snapshot overlays are disabled, conf.allowedDomains is not set').metrics('err.req.stdisabled');
        }
        if (!qparams.domain || !qparams.title) {
            throw new Err('Both domain and title params are required').metrics('err.req.stboth');
        }
        if (params.format !== 'png') {
            throw new Err('Only png format is allowed for images with overlays').metrics('err.req.stnonpng');
        }
        if (qparams.title.indexOf('|') !== -1) {
            throw new Err('title param may not contain pipe "|" symbol').metrics('err.req.stpipe');
        }
        protocol = parseProtocol(qparams.domain);

        let baseMapHdrs = {};

        return mapdataLoader(
            protocol, qparams.domain, qparams.title, qparams.groups
        ).then(geojson => {
            let mapPosition;

            if (params.lat === 'auto' || params.lon === 'auto' || params.zoom === 'auto') {
                mapPosition = autoPosition(params, geojson);
                params.lat = mapPosition.center[0];
                params.lon = mapPosition.center[1];
                params.zoom = mapPosition.zoom;
            } else {
                params.lat = core.strToFloat(params.lat);
                params.lon = core.strToFloat(params.lon);
            }
            params.zoom = core.validateZoom(params.zoom, source);

            let renderBaseMap = abaculus(makeParams(params, source.getHandler())).spread((data, headers) => {
                baseMapHdrs = headers;
                return mapnik.Image.fromBytesAsync(data);
            }).then(
                image => image.premultiplyAsync()
            );


            // This is far from ideal - we should be using geojson-mapnikify directly
            let renderOverlayMap = Promise.try(() => new Promise((accept, reject) => {

                // Render overlay layer
                let url = 'overlaydata://' + (params.scale === 2 ? '2x:' : '') + JSON.stringify( geojson );
                new Overlay( url, function ( err, overlay ) {
                    if ( err ) reject( err );
                    accept( overlay );
                } )
            })).then(
                overlay => abaculus(makeParams(params, overlay))
            ).then(
                overlayBuf => mapnik.Image.fromBytesAsync(overlayBuf[0])
            ).then(
                image => image.premultiplyAsync()
            );

            return Promise.join(
                renderBaseMap,
                renderOverlayMap,
                (baseImage, overlayImage) => {

                    return baseImage.compositeAsync(overlayImage);
                    // }).then(image => {
                    //     // Not sure if this step is needed - result appears identical
                    //     return image.demultiplyAsync();
                }
            );
        })
        .then(
            image => image.encodeAsync('png8:m=h:z=9')
        ).then(
            image => [image, baseMapHdrs]
        );

    }).spread((data, dataHeaders) => {
        core.setResponseHeaders(res, source, dataHeaders);

        res.send(data);

        let mx = util.format('req.%s.%s.%s.static', params.src, params.zoom, params.format);
        if (params.scale) {
            // replace '.' with ',' -- otherwise grafana treats it as a divider
            mx += '.' + (params.scale.toString().replace('.', ','));
        }
        core.metrics.endTiming(mx, start);
    }).catch(
        err => core.reportRequestError(err, res)
    ).catch(next);
}
