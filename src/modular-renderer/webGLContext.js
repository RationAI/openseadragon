(function($) {
    /**
     * @interface OpenSeadragon.WebGLModule.WebGLImplementation
     * Interface for the WebGL rendering implementation which can run on various GLSL versions.
     */
    $.WebGLModule.WebGLImplementation = class {
        /**
         * Create a WebGL rendering implementation.
         * @param {WebGLModule} renderer owner of this implementation
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
         * @param {String} webGLVersion "1.0" or "2.0"
         */
        constructor(renderer, gl, webGLVersion) {
            this.renderer = renderer;
            this.gl = gl;
            this.webGLVersion = webGLVersion;
        }

        /**
         * Static WebGLRenderingContext creation (to avoid class instantiation in case of missing support).
         * @param {HTMLCanvasElement} canvas
         * @param {Object} contextAttributes desired options used for the canvas webgl context creation
         * @return {WebGLRenderingContext|WebGL2RenderingContext}
         */
        static createWebglContext(canvas, webGLVersion, contextAttributes) {
            // indicates that the canvas contains an alpha buffer
            contextAttributes.alpha = true;
            // indicates that the page compositor will assume the drawing buffer contains colors with pre-multiplied alpha
            contextAttributes.premultipliedAlpha = true;

            if (webGLVersion === "1.0") {
                return canvas.getContext('webgl', contextAttributes);
            } else {
                return canvas.getContext('webgl2', contextAttributes);
            }
        }

        get firstPassProgramKey() {
            throw("$.WebGLModule.WebGLImplementation::firstPassProgram must be implemented!");
        }

        get secondPassProgramKey() {
            throw("$.WebGLModule.WebGLImplementation::secondPassProgram must be implemented!");
        }

        /**
         * Init phase
         */
        init() {

        }

        /**
         * Attach shaders and link WebGLProgram, catch errors.
         * @param {WebGLProgram} program
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
         * @param options build options
         * @param {String} options.vertexShader
         * @param {String} options.fragmentShader
         * @param {function} onError
         * @param {boolean} debug
         * @return {boolean} true if program was built successfully
         */
        static _compileProgram(program, gl, options, onError, debug = false) {
            /* Napriklad gl.getProgramParameter(program, gl.LINK_STATUS) pre kind = "Program", status = "LINK", value = program */
            function ok(kind, status, value, sh) {
                if (!gl['get' + kind + 'Parameter'](value, gl[status + '_STATUS'])) {
                    $.console.error((sh || 'LINK') + ':\n' + gl['get' + kind + 'InfoLog'](value));
                    return false;
                }
                return true;
            }

            /* Attach shader to the WebGLProgram, return true if valid. */
            function useShader(gl, program, data, type) {
                let shader = gl.createShader(gl[type]);
                gl.shaderSource(shader, data);
                gl.compileShader(shader);
                gl.attachShader(program, shader);
                program[type] = shader;
                return ok('Shader', 'COMPILE', shader, type);
            }

            function numberLines(str) {
                // from https://stackoverflow.com/questions/49714971/how-to-add-line-numbers-to-beginning-of-each-line-in-string-in-javascript
                return str.split('\n').map((line, index) => `${index + 1} ${line}`).join('\n');
            }

            // Attaching shaders to WebGLProgram failed
            if (!useShader(gl, program, options.vertexShader, 'VERTEX_SHADER') ||
                !useShader(gl, program, options.fragmentShader, 'FRAGMENT_SHADER')) {
                onError("Unable to correctly build WebGL shaders.",
                    "Attaching of shaders to WebGLProgram failed. For more information, see logs in the $.console.");
                $.console.warn("VERTEX SHADER\n", numberLines( options.vertexShader ));
                $.console.warn("FRAGMENT SHADER\n", numberLines( options.fragmentShader ));
                return false;
            } else { // Shaders attached
                gl.linkProgram(program);
                if (!ok('Program', 'LINK', program)) {
                    onError("Unable to correctly build WebGL program.",
                        "Linking of WebGLProgram failed. For more information, see logs in the $.console.");
                    $.console.warn("VERTEX SHADER\n", numberLines( options.vertexShader ));
                    $.console.warn("FRAGMENT SHADER\n", numberLines( options.fragmentShader ));
                    return false;
                } else if (debug) {
                    $.console.info("VERTEX SHADER\n", numberLines( options.vertexShader ));
                    $.console.info("FRAGMENT SHADER\n", numberLines( options.fragmentShader ));
                }
                return true;
            }
        }

        /**
         * Get WebGL version of the implementation.
         * @return {String} "1.0" or "2.0"
         */
        getVersion() {
            throw("$.WebGLModule.WebGLImplementation::getVersion() must be implemented!");
        }

        sampleTexture() {
            throw("$.WebGLModule.WebGLImplementation::sampleTexture() must be implemented!");
        }

        getTextureSize() {
            throw("$.WebGLModule.WebGLImplementation::getTextureSize() must be implemented!");
        }

        getShaderLayerGLSLIndex() {
            throw("$.WebGLModule.WebGLImplementation::getShaderLayerGLSLIndex() must be implemented!");
        }

        createProgram() {
            throw("$.WebGLModule.WebGLImplementation::createProgram() must be implemented!");
        }

        loadProgram() {
            throw("$.WebGLModule.WebGLImplementation::loadProgram() must be implemented!");
        }

        useProgram() {
            throw("$.WebGLModule.WebGLImplementation::useProgram() must be implemented!");
        }

        /**
         * Set viewport dimensions. Parent context already applied correct viewport settings to the
         * OpenGL engine. These values are already configured, but the webgl context can react to them.
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
            //no-op
        }

        destroy() {
        }

        /**
         * Get supported render modes by the renderer. First should be the default.
         * @return {string[]}
         */
        get supportedUseModes() {
            return ["show", "mask", "mask_clip"];
        }

        /**
         * Return sampling GLSL code (no function definition allowed) that implements blending passed by name
         * available are vec4 arguments 'fg' and 'bg'
         * e.g.:
         *   return vec4(fg.rgb * bg.a, fg.a);
         * @param {string} name one of OpenSeadragon.WebGLModule.BLEND_MODE
         * @return {string}
         */
        getBlendingFunction(name) {
            throw("$.WebGLModule.WebGLImplementation::blendingFunction must be implemented!");
        }
    };

    /**
     * WebGL Program instance
     */
    $.WebGLModule.Program = class {
        constructor(context, gl) {
            this.gl = gl;
            this.context = context;
            this._webGLProgram = null;
            this.fragmentShader = "";
            this.vertexShader = "";
        }

        get webGLProgram() {
            if (!this._webGLProgram) {
                throw Error("Program accessed without registration - did you call this.renderer.registerProgram()?");
            }
            return this._webGLProgram;
        }

        /**
         * Compile shader
         */
        build(shaderMap, shaderKeys) {
        }

        /**
         * Create program.
         * @param width
         * @param height
         */
        created(width, height) {
        }

        /**
         * Load program. No arguments. TODO refine, also with other methods
         */
        load() {
        }

        /**
         * Use program. Arbitrary arguments.
         */
        use() {
        }

        unload() {

        }

        /**
         * Destroy program. No arguments.
         */
        destroy() {
        }

// TODO we might want to fire only for active program and do others when really encesarry or with some delay, best at some common implementation level
        setDimensions(x, y, width, height, levels) {

        }

        /**
         * Iterate GLSL code
         */
        printN(fn, number, padding = "") {
            const output = new Array(number);
            for (let i = 0; i < number; i++) {
                output[i] = padding + fn(i);
            }
            return output.join('\n');
        }
    };

    $.WebGLModule.WebGL10 = class extends $.WebGLModule.WebGLImplementation {
        /**
         * Create a WebGL 1.0 rendering implementation.
         * @param {OpenSeadragon.WebGLModule} renderer
         * @param {WebGLRenderingContext} gl
         */
        constructor(renderer, gl) {
            // sets this.renderer, this.gl, this.webglVersion
            super(renderer, gl, "1.0");
            $.console.info("WebGl 1.0 renderer.");

            this._viewport = new Float32Array([
                0.0, 1.0, 1.0,
                0.0, 0.0, 1.0,
                1.0, 1.0, 1.0,
                1.0, 0.0, 1.0
            ]);
            this._locationPosition = null;          // a_position, attribute for viewport
            this._bufferPosition = null;            // buffer for viewport, will be filled with this._viewport

            this._locationTransformMatrix = null;   // u_transform_matrix, uniform to apply to viewport coords to get the correct rendering coords

            // maps ShaderLayer instantions to their GLSL indices (u_shaderLayerIndex)
            this._shadersMapping = {};              // {shaderUID1: 1, shaderUID2: 2, ...<more shaders>...}
            this._locationShaderLayerIndex = null;  // u_shaderLayerIndex, used to branch correctly to concrete ShaderLayer's rendering logic

            this._locationTextures = null;          // u_textures, uniform array for textures
            this._locationTextureCoords = null;     // a_texture_coords
            this._bufferTextureCoords = null;       // buffer for texture coords

            this._locationPixelSize = null;         // u_pixel_size
            this._locationZoomLevel = null;         // u_zoom_level
            this._locationGlobalAlpha = null;       // u_global_alpha
        }

        getVersion() {
            return "1.0";
        }

        /**
         * Expose GLSL code for texture sampling.
         * @returns {string} glsl code for texture sampling
         */
        sampleTexture(index, vec2coords) {
            return `osd_texture(${index}, ${vec2coords})`;
        }

        getTextureSize(index) {
            return `osd_texture_size(${index})`;
        }

        /**
         * Get glsl index of the ShaderLayer.
         * @param {string} id ShaderLayer's uid
         * @returns {Number} index of ShaderLayer in glsl
         */
        getShaderLayerGLSLIndex(shaderLayerUID) {
            return this._shadersMapping[shaderLayerUID];
        }

        /**
         * Create a WebGLProgram based on ShaderLayers supplied in an input parameter.
         * @param {Object} shaderLayers map of ShaderLayers to use {shaderID: ShaderLayer}, where shaderID is a unique identifier of the ShaderLayer (NOT equal to ShaderLayer's uid !!!)
         * @returns {WebGLProgram}
         */
        createProgram(shaderLayers) {
            const gl = this.gl;
            const program = gl.createProgram();

            let definition = '',
                execution = '',
                customBlendFunctions = '';


            // generate glsl code for each ShaderLayer, begin with index 1, 0 is reserved for the first-pass identity shader
            let i = 1;
            for (const shaderID in shaderLayers) {
                const shaderLayer = shaderLayers[shaderID];
                const shaderLayerIndex = i++;

                // assign ShaderLayer its glsl index, later obtained by getShaderLayerGLSLIndex(shaderLayerUID)
                this._shadersMapping[shaderLayer.uid] = shaderLayerIndex;

                definition += `\n    // Definition of ${shaderLayer.constructor.type()} shader:\n`;
                // returns string which corresponds to glsl code
                definition += shaderLayer.getFragmentShaderDefinition();
                definition += '\n';
                definition += `
 ${this.getModeFunction()}
    vec4 ${shaderLayer.uid}_execution() {${shaderLayer.getFragmentShaderExecution()}
    }`;
                definition += '\n\n';


                execution += ` else if (u_shaderLayerIndex == ${shaderLayerIndex}) {
            vec4 ${shaderLayer.uid}_out = ${shaderLayer.uid}_execution();`;

                execution += `
            ${shaderLayer.uid}_blend_mode(${shaderLayer.uid}_out);
        }`;


                // Todo webgl 1
        //         if (shaderLayer.usesCustomBlendFunction()) {
        //             customBlendFunctions += `
        // else if (last_blend_func_id == ${shaderLayerIndex}) {
        //     overall_color = ${shaderLayer.uid}_blend_func(last_color, overall_color);
        // }`;
        //         }
            } // end of for cycle

            const vertexShaderSource = this._getVertexShaderSource();
            const fragmentShaderSource = this._getFragmentShaderSource(definition, execution, customBlendFunctions, $.WebGLModule.ShaderLayer.__globalIncludes);
            const build = this.constructor._compileProgram(program, gl, {
                vertexShader: vertexShaderSource,
                fragmentShader: fragmentShaderSource
            }, $.console.error, this.renderer.debug);

            if (!build) {
                throw new Error("$.WebGLModule.WebGL10::createProgram: WebGLProgram could not be built!");
            }
            return program;
        }


        /**
         * Load the locations of glsl variables and initialize buffers.
         * @param {WebGLProgram} program WebGLProgram to load
         * @param {Object} shaderLayers map of ShaderLayers to load {shaderID: ShaderLayer}
         */
        loadProgram(program, shaderLayers) {
            const gl = this.gl;

            // load ShaderLayers' controls' glsl locations
            for (const shaderLayer of Object.values(shaderLayers)) {
                shaderLayer.glLoaded(program, gl);
            }

            // VERTEX shader
            this._locationTransformMatrix = gl.getUniformLocation(program, "u_transform_matrix");

            // initialize viewport attribute
            this._locationPosition = gl.getAttribLocation(program, "a_position");
            this._bufferPosition = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufferPosition);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0.0, 0.0, 0.0]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(this._locationPosition);
            gl.vertexAttribPointer(this._locationPosition, 3, gl.FLOAT, false, 0, 0);

            // initialize texture coords attribute
            this._locationTextureCoords = gl.getAttribLocation(program, "a_texture_coords");
            this._bufferTextureCoords = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufferTextureCoords);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0.0, 0.0]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(this._locationTextureCoords);
            gl.vertexAttribPointer(this._locationTextureCoords, 2, gl.FLOAT, false, 0, 0);


            // FRAGMENT shader
            this._locationPixelSize = gl.getUniformLocation(program, "u_pixel_size");
            this._locationZoomLevel = gl.getUniformLocation(program, "u_zoom_level");
            this._locationGlobalAlpha = gl.getUniformLocation(program, "u_global_alpha");
            this._locationShaderLayerIndex = gl.getUniformLocation(program, "u_shaderLayerIndex");

            // initialize texture
            this._locationTextures = gl.getUniformLocation(program, "u_textures");
            gl.uniform1i(this._locationTextures, 0);
            gl.activeTexture(gl.TEXTURE0);
        }


        /**
         * Fill the glsl variables and draw.
         * @param {WebGLProgram} program WebGLProgram in use

         * @param {Object} tileInfo
         * @param {Float32Array} tileInfo.transform 3*3 matrix that should be applied to viewport vertices
         * @param {Number} tileInfo.zoom
         * @param {Number} tileInfo.pixelSize
         * @param {number} renderInfo.globalOpacity
         * @param {Float32Array} tileInfo.textureCoords coordinates for texture sampling
         *
         * @param {ShaderLayer} shaderLayer ShaderLayer used for this draw call
         * @param {WebGLTexture} texture gl.TEXTURE_2D used as a source of data for rendering
         */
        useProgram(program, tileInfo, shaderLayer, texture) {
            const gl = this.gl;

            // tell the ShaderLayer's controls to fill their uniforms
            shaderLayer.glDrawing(program, gl);

            // which ShaderLayer to use
            const shaderLayerGLSLIndex = this.getShaderLayerGLSLIndex(shaderLayer.uid);
            gl.uniform1i(this._locationShaderLayerIndex, shaderLayerGLSLIndex);

            // fill the uniforms
            gl.uniform1f(this._locationPixelSize, tileInfo.pixelSize);
            gl.uniform1f(this._locationZoomLevel, tileInfo.zoom);
            gl.uniform1f(this._locationGlobalAlpha, tileInfo.globalOpacity);

            // viewport attribute
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufferPosition);
            gl.bufferData(gl.ARRAY_BUFFER, this._viewport, gl.STATIC_DRAW);

            // texture coords
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufferTextureCoords);
            gl.bufferData(gl.ARRAY_BUFFER, tileInfo.textureCoords, gl.STATIC_DRAW);

            // transform matrix
            gl.uniformMatrix3fv(this._locationTransformMatrix, false, tileInfo.transform);

            // texture
            gl.bindTexture(gl.TEXTURE_2D, texture);

            // draw triangle strip (two triangles)
            // 0: start reading vertex data from the first vertex
            // 4: use 4 vertices per instance (to form one triangle strip)
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }


        /**
         * Draw using first-pass identity ShaderLayer into an off-screen texture.
         * Function assumes that the framebuffer is already bound.
         *
         * @param {Float32Array} transformMatrix 3*3 matrix that should be applied to viewport vertices
         * @param {Float32Array} textureCoords coordinates for texture sampling
         * @param {WebGLTexture} texture gl.TEXTURE_2D used as a source of data for rendering
         */
        drawJoinTilesForViewport(transformMatrix, textureCoords, texture) {
            const gl = this.gl;

            // shaderLayer for the first-pass has special index = 0
            gl.uniform1i(this._locationShaderLayerIndex, 0);

            // viewport
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufferPosition);
            gl.bufferData(gl.ARRAY_BUFFER, this._viewport, gl.STATIC_DRAW);

            // texture coords
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufferTextureCoords);
            gl.bufferData(gl.ARRAY_BUFFER, textureCoords, gl.STATIC_DRAW);

            // transform matrix
            gl.uniformMatrix3fv(this._locationTransformMatrix, false, transformMatrix);

            // texture
            gl.bindTexture(gl.TEXTURE_2D, texture);

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        // PRIVATE FUNCTIONS
        /**
         * Get glsl function handling textures usage.
         * @returns {string} glsl code
         */
        _getTextureDefinition(instanceCount = 1) {
            function sampleTextures() {
                let retval = `if (index == 0) {
            return texture2D(u_textures[0], coords);
        }`;

                if (instanceCount === 1) {
                    return retval;
                }

                for (let i = 1; i < instanceCount; i++) {
                    retval += ` else if (index == ${i}) {
            return texture2D(u_textures[${i}], coords);
        }`;
                }

                return retval;
            }

            return `
    uniform sampler2D u_textures[${instanceCount}];
    vec4 osd_texture(int index, vec2 coords) {
        ${sampleTextures()}
    }

    // TODO: WebGL1 needs an uniform (here array probably)
    ivec2 osd_texture_size(int index) {
        return ivec2(1, 1);
    }
    `;
        }

        /**
         * Get vertex shader's glsl code.
         * @returns {string} vertex shader's glsl code
         */
        _getVertexShaderSource() {
        const vertexShaderSource = `
    precision mediump int;
    precision mediump float;
    /* This program is used for single-pass rendering and for second-pass during two-pass rendering. */

    attribute vec2 a_texture_coords;
    varying vec2 v_texture_coords;

    attribute vec3 a_position;
    uniform mat3 u_transform_matrix;

    void main() {
        v_texture_coords = a_texture_coords;
        gl_Position = vec4(u_transform_matrix * a_position, 1.0);
}`;

        return vertexShaderSource;
        }


        /**
         * Get fragment shader's glsl code.
         * @param {string} definition ShaderLayers' glsl code placed outside the main function
         * @param {string} execution ShaderLayers' glsl code placed inside the main function
         * @param {string} customBlendFunctions ShaderLayers' glsl code of their custom blend functions
         * @param {string} globalScopeCode ShaderLayers' glsl code shared between the their instantions
         * @returns {string} fragment shader's glsl code
         */
        _getFragmentShaderSource(definition, execution, customBlendFunctions, globalScopeCode) {
            const fragmentShaderSource = `
    precision mediump int;
    precision mediump float;
    precision mediump sampler2D;

    uniform float u_pixel_size;
    uniform float u_zoom_level;
    uniform float u_global_alpha;
    uniform int u_shaderLayerIndex;


    // TEXTURES
    varying vec2 v_texture_coords;
    ${this._getTextureDefinition()}

    // UTILITY function
    bool close(float value, float target) {
        return abs(target - value) < 0.001;
    }

    // BLEND attributes
    vec4 overall_color = vec4(.0);
    vec4 last_color = vec4(.0);
    vec4 current_color = vec4(.0);
    int last_blend_func_id = -1000;
    void deffered_blend();


    // GLOBAL SCOPE CODE:${Object.keys(globalScopeCode).length !== 0 ?
        Object.values(globalScopeCode).join("\n") :
        '\n    // No global scope code here...'}

    // DEFINITIONS OF SHADERLAYERS:${definition !== '' ? definition : '\n    // Any non-default shaderLayer here to define...'}


    // DEFFERED BLENDING mechanism:
    void deffered_blend() {
        // predefined "additive blending":
        if (last_blend_func_id == -1) {
            overall_color = last_color + overall_color;

        // predefined "premultiplied alpha blending":
        } else if (last_blend_func_id == -2) {
            vec4 pre_fg = vec4(last_color.rgb * last_color.a, last_color.a);
            overall_color = pre_fg + overall_color * (1.0 - pre_fg.a);


        // non-predefined, custom blending functions:
        }${customBlendFunctions === '' ? '\n            // No custom blending function here...' : customBlendFunctions}
    }


    void main() {
        // EXECUTIONS OF SHADERLAYERS:
        ${execution}

        // default case; should not happen
        else {
            if (osd_texture(0, v_texture_coords).rgba == vec4(.0)) {
                gl_FragColor = vec4(.0);
            } else { // render only where there's data in the texture
                gl_FragColor = vec4(1, 0, 0, 0.5);
            }
            return;
        }

        // blend last level
        deffered_blend();
        gl_FragColor = overall_color * u_global_alpha;
    }`;

            return fragmentShaderSource;
        }

        /**
         * TODO make private
         * @returns {String} GLSL code of the ShaderLayer's blend mode's logic
         */
        getModeFunction(shaderLayer) {
            let modeDefinition = `void ${shaderLayer.uid}_blend_mode(vec4 color) {`;
            if (shaderLayer._mode === "show") {
                modeDefinition += `
        // blend last_color with overall_color using blend_func of the last shader using deffered blending
        deffered_blend();
        last_color = color;
        // switch case -2 = predefined "premultiplied alpha blending"
        last_blend_func_id = -2;
    }`;
            }
            else if (shaderLayer._mode === "mask") {
                modeDefinition += `
        // blend last_color with overall_color using blend_func of the last shader using deffered blending
        deffered_blend();
        last_color = color;
        // switch case pointing to this.getCustomBlendFunction() code
        last_blend_func_id = ${this.getShaderLayerGLSLIndex(shaderLayer.uid)};
    }`;
            } else if (shaderLayer._mode === "mask_clip") {
                modeDefinition += `
        last_color = ${shaderLayer.uid}_blend_func(color, last_color);
    }`;
            }

            return modeDefinition;
        }
    };

})(OpenSeadragon);
