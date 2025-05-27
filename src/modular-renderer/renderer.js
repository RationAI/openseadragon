(function($) {
    /**
     * @typedef {Object} ShaderConfig
     * @property {String} shaderConfig.id
     * @property {String} shaderConfig.name
     * @property {String} shaderConfig.type         equal to ShaderLayer.type(), e.g. "identity"
     * @property {Number} shaderConfig.visible      1 = use for rendering, 0 = do not use for rendering
     * @property {Boolean} shaderConfig.fixed
     * @property {Object} shaderConfig.params          settings for the ShaderLayer
     * @property {OpenSeadragon.TiledImage[]|number[]} tiledImages images that provide the data
     * @property {Object} shaderConfig._controls       storage for the ShaderLayer's controls
     * @property {Object} shaderConfig._cache          cache object used by the ShaderLayer's controls
     */

    /**
     * @typedef {Object} FPRenderPackageItem
     * @property {WebGLTexture[]} texture           [TEXTURE_2D]
     * @property {Float32Array} textureCoords
     * @property {Float32Array} transformMatrix
     * //todo provide also opacity per tile?
     */

    /**
     * @typedef {Object} FPRenderPackage
     * @property {FPRenderPackageItem} tiles
     * @property {Number[][]} stencilPolygons
     */

    /**
     * @typedef {Object} SPRenderPackage
     * @property {Number} zoom
     * @property {Number} pixelsize
     * @property {Number} opacity
     * @property {ShaderLayer} shader
     * @property {Uint8Array|undefined} iccLut  TODO also support error rendering by passing some icon texture & rendering where nothing was rendered but should be (-> use mask, but how we force tiles to come to render if they are failed?  )
     */

    /**
     * @typedef {Object} FPOutput
     * @typedef {Object} SPOutput
     */

    /**
     * WebGL Renderer for OpenSeadragon.
     *
     * Renders in two passes:
     *  1st pass joins tiles and creates masks where we should draw
     *  2nd pass draws the actual data using shaders
     *
     * @property {RegExp} idPattern
     * @property {Object} BLEND_MODE
     *
     * @class OpenSeadragon.WebGLModule
     * @classdesc class that manages ShaderLayers, their controls, and WebGLContext to allow rendering using WebGL
     * @memberof OpenSeadragon
     */
    $.WebGLModule = class extends $.EventSource {

        /**
         * @param {Object} incomingOptions
         *
         * @param {String} incomingOptions.uniqueId
         *
         * @param {String} incomingOptions.webGLPreferredVersion    prefered WebGL version, "1.0" or "2.0"
         *
         * @param {Function} incomingOptions.ready                  function called when WebGLModule is ready to render
         * @param {Function} incomingOptions.resetCallback          function called when user input changed; triggers re-render of the viewport
         * @param {Function} incomingOptions.refetchCallback        function called when underlying data changed; triggers re-initialization of the whole WebGLDrawer
         * @param {Boolean} incomingOptions.debug                   debug mode on/off
         * @param {Boolean} incomingOptions.interactive             if true (default), the layers are configured for interactive changes (not applied by default)
         *
         * @param {Object} incomingOptions.canvasOptions
         * @param {Boolean} incomingOptions.canvasOptions.alpha
         * @param {Boolean} incomingOptions.canvasOptions.premultipliedAlpha
         * @param {Boolean} incomingOptions.canvasOptions.stencil
         *
         * @constructor
         * @memberof WebGLModule
         */
        constructor(incomingOptions) {
            super();

            if (!this.constructor.idPattern.test(incomingOptions.uniqueId)) {
                throw new Error("$.WebGLModule::constructor: invalid ID! Id can contain only letters, numbers and underscore. ID: " + incomingOptions.uniqueId);
            }
            this.uniqueId = incomingOptions.uniqueId;

            this.webGLPreferredVersion = incomingOptions.webGLPreferredVersion;


            this.ready = incomingOptions.ready;
            this.resetCallback = incomingOptions.resetCallback;
            this.refetchCallback = incomingOptions.refetchCallback;
            this.debug = incomingOptions.debug;
            this.interactive = !!incomingOptions.interactive;

            this.running = false;           // boolean; true if WebGLModule is ready to render
            this._program = null;            // WebGLProgram
            this._shaders = {};
            this._shadersOrder = [];
            this._programImplementations = {};

            this.canvasContextOptions = incomingOptions.canvasOptions;
            const canvas = document.createElement("canvas");
            const WebGLImplementation = this.constructor.determineContext(this.webGLPreferredVersion);
            const webGLRenderingContext = $.WebGLModule.WebGLImplementation.createWebglContext(canvas, this.webGLPreferredVersion, this.canvasContextOptions);
            if (webGLRenderingContext) {
                this.gl = webGLRenderingContext;                                            // WebGLRenderingContext|WebGL2RenderingContext
                this.webglContext = new WebGLImplementation(this, webGLRenderingContext);   // $.WebGLModule.WebGLImplementation
                this.canvas = canvas;

                // Should be last call of the constructor to make sure everything is initialized
                this.webglContext.init();
            } else {
                throw new Error("$.WebGLModule::constructor: Could not create WebGLRenderingContext!");
            }
        }

        /**
         * Search through all WebGLModule properties to find one that extends WebGLImplementation and it's getVersion() method returns <version> input parameter.
         * @param {String} version WebGL version, "1.0" or "2.0"
         * @returns {WebGLImplementation}
         *
         * @instance
         * @memberof WebGLModule
         */
        static determineContext(version) {
            const namespace = $.WebGLModule;
            for (let property in namespace) {
                const context = namespace[ property ],
                    proto = context.prototype;
                if (proto && proto instanceof namespace.WebGLImplementation &&
                    $.isFunction( proto.getVersion ) && proto.getVersion.call( context ) === version) {
                        return context;
                }
            }

            throw new Error("$.WebGLModule::determineContext: Could not find WebGLImplementation with version " + version);
        }

        /**
         * Get Currently used WebGL version
         * @return {String|*}
         */
        get webglVersion() {
            return this.webglContext.webGLVersion;
        }

        /**
         * Set viewport dimensions.
         * @param {Number} x
         * @param {Number} y
         * @param {Number} width
         * @param {Number} height
         * @param {Number} levels number of layers that are rendered, kind of 'depth' parameter, an integer
         *
         * @instance
         * @memberof WebGLModule
         */
        setDimensions(x, y, width, height, levels) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.gl.viewport(x, y, width, height);
            this.webglContext.setDimensions(x, y, width, height, levels);
        }

        /**
         * Call to first-pass draw using WebGLProgram.
         * @param {FPRenderPackage[]} source
         * @return {FPOutput}
         * @instance
         * @memberof WebGLModule
         */
        firstPassProcessData(source) {
            const program = this._programImplementations[this.webglContext.firstPassProgramKey];
            if (this.useProgram(program, "first-pass")) {
                program.load();
            }
            return program.use(source);
        }

        /**
         * Call to second-pass draw
         * @param {FPOutput} source
         * @param {SPRenderPackage[]} renderArray
         * @return {*}
         */
        secondPassProcessData(source, renderArray) {
            const program = this._programImplementations[this.webglContext.secondPassProgramKey];
            if (this.useProgram(program, "second-pass")) {
                program.load(renderArray);
            }
            return program.use(source, renderArray);
        }

        /**
         * Create and load the new WebGLProgram based on ShaderLayers and their controls.
         * @param {OpenSeadragon.WebGLModule.Program} program
         * @param {String} [key] optional ID for the program to use
         * @return {String} ID for the program it was registered with
         *
         * @instance
         * @protected
         * @memberof WebGLModule
         */
        registerProgram(program, key = undefined) {
            key = key || String(Date.now());

            if (!program) {
                program = this._programImplementations[key];
            }
            if (this._programImplementations[key]) {
                this.deleteProgram(key);
            }

            const webglProgram = this.gl.createProgram();
            program._webGLProgram = webglProgram;
            program.build(this._shaders, this._shadersOrder || Object.keys(this._shaders)); //todo somehow make shaders registrable to different workflows
            // Used also to re-compile, set requiresLoad to true
            program.requiresLoad = true;

            if (!program.vertexShader || !program.fragmentShader) {
                this.gl.deleteProgram(webglProgram);
                program._webGLProgram = null;
                throw Error("Program does not define vertexShader or fragmentShader shader property!");
            }

            this._programImplementations[key] = program;
            if ($.WebGLModule.WebGLImplementation._compileProgram(
                webglProgram, this.gl, program, $.console.error, this.debug
            )) {
                program.created(webglProgram, this.canvas.width, this.canvas.height);
                return key;
            }
            return undefined;
        }

        /**
         * Switch program
         * @param {OpenSeadragon.WebGLModule.Program|string} program instance or program key to use
         * @param {string} name "first-pass" or "second-pass"
         * @return {boolean} false if update is not necessary, true if update was necessary -- updates
         * are initialization steps taken once after program is first loaded (after compilation)
         * or when explicitly re-requested
         */
        useProgram(program, name) {
            if (!(program instanceof $.WebGLModule.Program)) {
                program = this.getProgram(program);
            }

            if (this.running && this._program === program) {
                return false;
            } else if (this._program) {
                this._program.unload();
            }

            this._program = program;
            this.gl.useProgram(program.webGLProgram);

            const needsUpdate = this._program.requiresLoad;
            this._program.requiresLoad = false;

            if (needsUpdate) {
                /**
                 * todo better docs
                 * Fired after program has been switched to (initially or when changed).
                 * The event happens BEFORE JS logics executes within ShaderLayers.
                 * @event program-used
                 */
                this.raiseEvent('program-used', {
                    name: name,
                    program: program,
                    shaderLayers: this._shaders,
                });

                // initialize ShaderLayer's controls:
                //      - set their values to default,
                //      - if interactive register event handlers to their corresponding DOM elements created in the previous step

                //todo consider events, consider doing within webgl context
                if (name === "second-pass") {
                    for (const shaderLayer of Object.values(this._shaders)) {
                        shaderLayer.init();
                    }
                }
            }

            if (!this.running) {
                //TODO: might not be the best place to call, timeout necessary to allow finish initialization of OSD before called
                setTimeout(() => this.ready());
                this.running = true;
            }
            return needsUpdate;
        }

        /**
         *
         */
        requireLoad() {
            //todo delete? we should enable requirement to re-load programs! maybe call on each program if not specified
        }

        /**
         *
         * @param {string} programKey
         * @return {OpenSeadragon.WebGLModule.Program}
         */
        getProgram(programKey) {
            return this._programImplementations[programKey];
        }

        /**
         *
         * @param {string} key program key to delete
         */
        deleteProgram(key) {
            const implementation = this._programImplementations[key];
            if (!implementation) {
                return;
            }
            implementation.destroy();
            this.gl.deleteProgram(implementation._webGLProgram);
            this._programImplementations[key] = null;
        }

        /**
         * Create and initialize new ShaderLayer instantion and its controls.
         * @param id
         * @param {ShaderConfig} shaderConfig object bound to a concrete ShaderLayer instance
         * @returns {ShaderLayer} instance of the created shaderLayer
         *
         * @instance
         * @memberof WebGLModule
         */
        createShaderLayer(id, shaderConfig) {
            const Shader = $.WebGLModule.ShaderMediator.getClass(shaderConfig.type);
            if (!Shader) {
                throw new Error(`$.WebGLModule::createShaderLayer: Unknown shader type '${shaderConfig.type}'!`);
            }

            // TODO a bit dirty approach, make the program key usable from outside
            const shader = new Shader(id, {
                shaderConfig: shaderConfig,
                webglContext: this.webglContext,
                controls: shaderConfig._controls,
                cache: shaderConfig._cache,
                params: shaderConfig.params,
                interactive: this.interactive,

                // callback to re-render the viewport
                invalidate: this.resetCallback,
                // callback to rebuild the WebGL program
                rebuild: () => {
                    this.registerProgram(null, this.webglContext.secondPassProgramKey);
                },
                // callback to reinitialize the drawer; NOT USED
                refetch: this.refetchCallback
            });

            shader.construct();
            this._shaders[id] = shader;
            return shader;
        }

        getAllShaders() {
            return this._shaders;
        }

        /**
         *
         * @param order
         */
        setShaderLayerOrder(order) {
            this._shadersOrder = order;
        }

        /**
         *
         * Retrieve the order
         * @return {*}
         */
        getShaderLayerOrder() {
            return this._shadersOrder;
        }

        /**
         * Remove ShaderLayer instantion and its controls.
         * @param {string} id shader id
         *
         * @instance
         * @memberof WebGLModule
         */
        removeShader(id) {
            const shader = this._shaders[id];
            if (!shader) {
                return;
            }
            shader.destroy();
            delete this._shaders[id];
        }

        /**
         * Clear all shaders
         */
        deleteShaders() {
            for (let sId in this._shaders) {
                this.removeShader(sId);
            }
        }

        /**
         * @param {Boolean} enabled if true enable alpha blending, otherwise disable blending
         *
         * @instance
         * @memberof WebGLModule
         */
        setDataBlendingEnabled(enabled) {
            if (enabled) {
                this.gl.enable(this.gl.BLEND);

                // standard alpha blending
                this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
            } else {
                this.gl.disable(this.gl.BLEND);
            }
        }

        destroy() {
            for (let pId in this._programImplementations) {
                this.deleteProgram(pId);
            }
            this.webglContext.destroy();
            this._programImplementations = {};
        }
    };


    // STATIC PROPERTIES
    /**
     * ID pattern allowed for WebGLModule. ID's are used in GLSL to distinguish uniquely between individual ShaderLayer's generated code parts
     * @property
     * @type {RegExp}
     * @memberof WebGLModule
     */
    $.WebGLModule.idPattern = /^(?!_)(?:(?!__)[0-9a-zA-Z_])*$/;

    $.WebGLModule.BLEND_MODE = [
        'mask',
        'source-over',
        'source-in',
        'source-out',
        'source-atop',
        'destination-over',
        'destination-in',
        'destination-out',
        'destination-atop',
        'lighten',
        'darken',
        'copy',
        'xor',
        'multiply',
        'screen',
        'overlay',
        'color-dodge',
        'color-burn',
        'hard-light',
        'soft-light',
        'difference',
        'exclusion',
        'hue',
        'saturation',
        'color',
        'luminosity',
    ];

    $.WebGLModule.jsonReplacer = function (key, value) {
        return key.startsWith("_") || ["eventSource"].includes(key) ? undefined : value;
    };
})(OpenSeadragon);
