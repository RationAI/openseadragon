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
        static create(canvas, webGLVersion, contextAttributes) {
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

        /**
         * Attach shaders and link WebGLProgram, catch errors.
         * @param {WebGLProgram} program
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
         * @param {function(error: string, description: string)} onError callback to call when error happens
         * @return {boolean} true if program was built successfully
         */
        static _compileProgram(program, gl, onError, debug = false) {
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

            const opts = program._osdOptions;
            if (!opts) {
                $.console.error("Invalid program compilation! Did you build shaders using compile[Type]Shader() methods?");
                onError("Invalid program.", "Program not compatible with this renderer!");
                return false;
            }

            // Attaching shaders to WebGLProgram failed
            if (!useShader(gl, program, opts.vs, 'VERTEX_SHADER') ||
                !useShader(gl, program, opts.fs, 'FRAGMENT_SHADER')) {
                onError("Unable to correctly build WebGL shaders.",
                    "Attaching of shaders to WebGLProgram failed. For more information, see logs in the $.console.");
                $.console.warn("VERTEX SHADER\n", numberLines( opts.vs ));
                $.console.warn("FRAGMENT SHADER\n", numberLines( opts.fs ));
                return false;
            } else { // Shaders attached
                gl.linkProgram(program);
                if (!ok('Program', 'LINK', program)) {
                    onError("Unable to correctly build WebGL program.",
                        "Linking of WebGLProgram failed. For more information, see logs in the $.console.");
                    return false;
                } else if (debug) {
                    $.console.info("VERTEX SHADER\n", numberLines( opts.vs ));
                    $.console.info("FRAGMENT SHADER\n", numberLines( opts.fs ));
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
    };

    $.WebGLModule.WebGL20 = class extends $.WebGLModule.WebGLImplementation {
        /**
         * Create a WebGL 2.0 rendering implementation.
         * @param {OpenSeadragon.WebGLModule} renderer
         * @param {WebGL2RenderingContext} gl
         */
        constructor(renderer, gl) {
            // sets this.renderer, this.gl, this.webGLVersion
            super(renderer, gl, "2.0");
            $.console.info("WebGl 2.0 renderer.");

            this._locationTransformMatrix = null;   // u_transform_matrix, uniform to apply to viewport coords to get the correct rendering coords

            // maps ShaderLayer instantions to their GLSL indices (u_shaderLayerIndex) -> {shaderUID1: 1, shaderUID2: 2, ...<more shaders>...}
            this._shadersMapping = {};
            this._locationShaderLayerIndex = null;  // u_shaderLayerIndex, used to branch correctly to concrete ShaderLayer's rendering logic

            this._locationTextureArray = null;      // u_textureArray, TEXTURE_2D_ARRAY
            this._locationTextureLayer = null;      // u_textureLayer, tells which layer from TEXTURE_2D_ARRAY to use
            this._locationTextureCoords = null;     // a_texture_coords
            this._bufferTextureCoords = null;       // buffer for texture coords

            this._locationPixelSize = null;         // u_pixel_size
            this._locationZoomLevel = null;         // u_zoom_level
            this._locationGlobalAlpha = null;       // u_global_alpha
        }

        getVersion() {
            return "2.0";
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

            // first-pass identity shader is a special case, no blend mode nor blend function, no controls, just pure identity => generate glsl manually now
            definition += `\n    // Definition of special identity shader used for the first-pass:`;
            definition += `
    vec4 first_pass_identity_execution() {${this.renderer.firstPassShader.getFragmentShaderExecution()}
    }`;
            definition += '\n\n';

            execution += `
            case 0:`;
            execution += `
                overall_color = first_pass_identity_execution();
                return;\n`;


            // generate glsl code for each ShaderLayer, begin with index 1, 0 is reserved for the first-pass identity shader
            let i = 1;
            for (const shaderID in shaderLayers) {
                const shaderLayer = shaderLayers[shaderID];
                const shaderLayerIndex = i++;

                // assign ShaderLayer its glsl index, later obtained by getShaderLayerGLSLIndex(shaderLayerUID)
                this._shadersMapping[shaderLayer.uid] = shaderLayerIndex;

                definition += `\n    // Definition of ${shaderLayer.constructor.type()} shader:\n`;
                definition += shaderLayer.getFragmentShaderDefinition();
                definition += '\n';
                definition += `
    vec4 ${shaderLayer.uid}_execution() {${shaderLayer.getFragmentShaderExecution()}
    }`;
                definition += '\n\n';


                execution += `
            case ${shaderLayerIndex}:
                vec4 ${shaderLayer.uid}_out = ${shaderLayer.uid}_execution();`;

                execution += `
                ${shaderLayer.uid}_blend_mode(${shaderLayer.uid}_out);
                break;`;


                if (shaderLayer.usesCustomBlendFunction()) {
                    customBlendFunctions += `
        case ${shaderLayerIndex}:
            overall_color = ${shaderLayer.uid}_blend_func(last_color, overall_color);
            break;`;
                }
            } // end of for cycle


            const vertexShaderSource = this._getVertexShaderSource();
            const fragmentShaderSource = this._getFragmentShaderSource(definition, execution, customBlendFunctions, $.WebGLModule.ShaderLayer.__globalIncludes);

            program._osdOptions = {};
            program._osdOptions.vs = vertexShaderSource;
            program._osdOptions.fs = fragmentShaderSource;

            const build = this.constructor._compileProgram(program, gl, $.console.error, this.renderer.debug);
            if (!build) {
                throw new Error("$.WebGLModule.WebGL20::createProgram: WebGLProgram could not be built!");
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

            // ShaderLayers' controls
            for (const shaderLayer of Object.values(shaderLayers)) {
                shaderLayer.glLoaded(program, gl);
            }

            // VERTEX shader
            this._locationTransformMatrix = gl.getUniformLocation(program, "u_transform_matrix");

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
            this._locationTextureArray = gl.getUniformLocation(program, "u_textureArray");
            this._locationTextureLayer = gl.getUniformLocation(program, "u_textureLayer");
            gl.uniform1i(this._locationTextureArray, 0);
            gl.activeTexture(gl.TEXTURE0);
        }


        /**
         * Fill the glsl variables and draw.
         * @param {WebGLProgram} program WebGLProgram in use

         * @param {Object} tileInfo
         * @param {Float32Array} tileInfo.transform 3*3 matrix that should be applied to viewport vertices
         * @param {Number} tileInfo.zoom
         * @param {Number} tileInfo.pixelSize
         * @param {Float32Array} tileInfo.textureCoords coordinates for texture sampling
         *
         * @param {ShaderLayer} shaderLayer ShaderLayer used for this draw call
         * @param {WebGLTexture} textureArray gl.TEXTURE_2D_ARRAY used as source of data for rendering
         * @param {Number} textureLayer index to layer in textureArray to use
         */
        useProgram(program, tileInfo, shaderLayer, textureArray, textureLayer) {
            const gl = this.gl;

            // tell the ShaderLayer's controls to fill their uniforms
            shaderLayer.glDrawing(program, gl);

            // which ShaderLayer to use
            gl.uniform1i(this._locationShaderLayerIndex, this.getShaderLayerGLSLIndex(shaderLayer.uid));

            // fill the uniforms
            gl.uniform1f(this._locationPixelSize, tileInfo.pixelSize);
            gl.uniform1f(this._locationZoomLevel, tileInfo.zoom);
            gl.uniform1f(this._locationGlobalAlpha, tileInfo.globalOpacity);

            // texture coords
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufferTextureCoords);
            gl.bufferData(gl.ARRAY_BUFFER, tileInfo.textureCoords, gl.STATIC_DRAW);

            // transform matrix
            gl.uniformMatrix3fv(this._locationTransformMatrix, false, tileInfo.transform);

            // texture
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, textureArray);
            gl.uniform1i(this._locationTextureLayer, textureLayer);

            // draw triangle strip (two triangles) from a static array defined in the vertex shader
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
         * @param {WebGLTexture} textureArray gl.TEXTURE_2D_ARRAY used as a source of data for rendering
         * @param {Number} textureLayer index to layer in textureArray to use
         */
        useProgramForFirstPass(transformMatrix, textureCoords, textureArray, textureLayer) {
            const gl = this.gl;

            // shaderLayer for the first-pass has special index = 0
            gl.uniform1i(this._locationShaderLayerIndex, 0);

            // texture coords
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufferTextureCoords);
            gl.bufferData(gl.ARRAY_BUFFER, textureCoords, gl.STATIC_DRAW);

            // transform matrix
            gl.uniformMatrix3fv(this._locationTransformMatrix, false, transformMatrix);

            // texture
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, textureArray);
            gl.uniform1i(this._locationTextureLayer, textureLayer);

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }



        // PRIVATE FUNCTIONS
        /**
         * Get vertex shader's glsl code.
         * @returns {string} vertex shader's glsl code
         */
        _getVertexShaderSource() {
            const vertexShaderSource = `#version 300 es
        precision mediump int;
        precision mediump float;
        /* This program is used for single-pass rendering and for second-pass during two-pass rendering. */

        in vec2 a_texture_coords;
        out vec2 v_texture_coords;
        uniform mat3 u_transform_matrix;

        const vec3 viewport[4] = vec3[4] (
            vec3(0.0, 1.0, 1.0),
            vec3(0.0, 0.0, 1.0),
            vec3(1.0, 1.0, 1.0),
            vec3(1.0, 0.0, 1.0)
        );

        void main() {
            v_texture_coords = a_texture_coords;
            gl_Position = vec4(u_transform_matrix * viewport[gl_VertexID], 1.0);
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
            const fragmentShaderSource = `#version 300 es
        precision mediump int;
        precision mediump float;
        precision mediump sampler2DArray;

        uniform float u_pixel_size;
        uniform float u_zoom_level;
        uniform float u_global_alpha;
        uniform int u_shaderLayerIndex;


        // TEXTURES
        in vec2 v_texture_coords;
        uniform sampler2DArray u_textureArray;
        uniform int u_textureLayer;
        vec4 osd_texture(int index, vec2 coords) {
            return texture(u_textureArray, vec3(coords, float(u_textureLayer)));
        }

        ivec2 osd_texture_size(int index) {
            return textureSize(u_textureArray, 0).xy;
        }

        // UTILITY function
        bool close(float value, float target) {
            return abs(target - value) < 0.001;
        }

        // BLEND attributes
        out vec4 overall_color;
        vec4 last_color = vec4(.0);
        vec4 current_color = vec4(.0);
        int last_blend_func_id = -1000;
        void deffered_blend();


        // GLOBAL SCOPE CODE:${Object.keys(globalScopeCode).length !== 0 ?
            Object.values(globalScopeCode).join("\n") : '\n    // No global scope code here...'}


        // DEFINITIONS OF SHADERLAYERS:${definition !== '' ? definition : '\n    // Any non-default shaderLayer here to define...'}


        // DEFFERED BLENDING mechanism:
        void deffered_blend() {
            // switch (last_blend_func_id) {
            // // predefined "additive blending":
            // case -1:
            //     overall_color = last_color + overall_color;
            //     break;
            //
            // // predefined "premultiplied alpha blending":
            // case -2:
            //     vec4 pre_fg = vec4(last_color.rgb * last_color.a, last_color.a);
            //     overall_color = pre_fg + overall_color * (1.0 - pre_fg.a);
            //     break;
            //
            //
            // // non-predefined, custom blending functions:${customBlendFunctions === '' ? '\n            // No custom blending function here...' : customBlendFunctions}
            // }

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
            switch (u_shaderLayerIndex) {${execution}

            default: // default case; should not happen
                if (osd_texture(0, v_texture_coords).rgba == vec4(.0)) {
                    overall_color = vec4(.0);
                } else { // render only where there's data in the texture
                    overall_color = vec4(1, 0, 0, 0.5);
                }
                return;
            }

            // blend last level
            deffered_blend();
            overall_color *= u_global_alpha;
        }`;

            return fragmentShaderSource;
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


            // first pass identity shader is a special case, no blend nor clip, no controls, just pure identity, generate glsl manually now
            definition += `\n    // Definition of special identity shader used for the first-pass:`;
            definition += `
    vec4 first_pass_identity_execution() {${this.renderer.firstPassShader.getFragmentShaderExecution()}
    }`;
            definition += '\n\n';

            execution += `if (u_shaderLayerIndex == 0) {`;
            execution += `
            gl_FragColor = first_pass_identity_execution();
            return;
        }`;


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
    vec4 ${shaderLayer.uid}_execution() {${shaderLayer.getFragmentShaderExecution()}
    }`;
                definition += '\n\n';


                execution += ` else if (u_shaderLayerIndex == ${shaderLayerIndex}) {
            vec4 ${shaderLayer.uid}_out = ${shaderLayer.uid}_execution();`;

                execution += `
            ${shaderLayer.uid}_blend_mode(${shaderLayer.uid}_out);
        }`;


                if (shaderLayer.usesCustomBlendFunction()) {
                    customBlendFunctions += `
        else if (last_blend_func_id == ${shaderLayerIndex}) {
            overall_color = ${shaderLayer.uid}_blend_func(last_color, overall_color);
        }`;
                }
            } // end of for cycle

            const vertexShaderSource = this._getVertexShaderSource();
            const fragmentShaderSource = this._getFragmentShaderSource(definition, execution, customBlendFunctions, $.WebGLModule.ShaderLayer.__globalIncludes);

            program._osdOptions = {};
            program._osdOptions.vs = vertexShaderSource;
            program._osdOptions.fs = fragmentShaderSource;

            const build = this.constructor._compileProgram(program, gl, $.console.error, this.renderer.debug);
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
        useProgramForFirstPass(transformMatrix, textureCoords, texture) {
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
    };

})(OpenSeadragon);
