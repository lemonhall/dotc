var fs = require('fs');
var path = require('path');

var tokenize = require('c-tokenizer');
var split = require('split');
var combine = require('stream-combiner');
var Transform = require('stream').Transform;

var sequences = {
    require: [
        { type: 'directive', content: '#require' },
        { type: 'whitespace' },
        { type: 'quote' },
        { type: 'whitespace' },
        { type: 'identifier', content: 'as' },
        { type: 'whitespace' },
        { type: 'identifier' },
    ],
    'export': [
        { type: 'directive', content: '#export' },
        { type: 'whitespace' },
        { type: 'identifier' },
        { type: 'whitespace' },
        { type: 'identifier', content: 'as', optional: true },
        { type: 'whitespace' },
        { type: 'identifier' }
    ],
    'export=': [
        { type: 'directive', content: '#export=' },
        { type: 'whitespace' },
        { type: 'identifier' }
    ]
};

function makeState (name, cb) {
    return {
        states: sequences[name].concat(cb),
        tokens: [],
        index: 0
    };
}

module.exports = function parse (dir) {
    var t = tokenize();
    
    var ns = '_' + Math.floor(Math.pow(16,8) * Math.random()).toString(16);
    t.namespace = ns;
    
    var required = {};
    var exported = {};
    var states = [];
    
    states.push(makeState('require', function (tokens, next) {
        var p = tokens[2].content.replace(/^"|"$/g, '');
        
        var file = path.resolve(dir, p);
        var rs = fs.createReadStream(file);
        var sub = rs.pipe(parse(path.dirname(file)));
        
        sub.on('export', function (nsp, ex, local) {
            if (!exported[nsp]) exported[nsp] = {};
            if (exported[nsp]['=']) {
                return emit('error', new Error(
                    'multi export attempted with existing single export'
                ));
            }
            exported[nsp][ex] = local;
        });
        
        sub.on('export=', function (nsp, ex) {
            if (exported[nsp]) {
                emit('error', 'single export attempted with '
                    + 'existing multi exports'
                );
            }
            else {
                exported[nsp] = { '=': ex };
            }
        });
        
        emit('require', p, tokens[6].content);
        required[tokens[6].content] = sub.namespace;
        
        tr.push('namespace ' + sub.namespace + ' {');
        
        sub.on('data', function (buf) { tr.push(buf) });
        sub.on('end', function () {
            tr.push('};');
            next();
        });
    }));
    
    states.push(makeState('export', function (tokens, next) {
        if (tokens.length === 4) {
            emit('export', ns, tokens[2].content, tokens[2].content);
        }
        else {
            emit('export', ns, tokens[6].content, tokens[2].content);
        }
        next();
    }));
    
    states.push(makeState('export=', function (tokens, next) {
        emit('export=', ns, tokens[2].content);
        next();
    }));
    
    var matching = null;
    var waiting = null;
    
    var tr = new Transform({ objectMode: true });
    tr._transform = function (token, enc, next) {
        var src = token.content;
                
        if (waiting && waiting.name === 'exported') {
            if (token.type === 'whitespace') {}
            else if (token.type === 'operator' && token.content === '.') {
                waiting.name = 'import id';
            }
            else {
                return emit('error', new Error(
                    'expected (.) operator, got: '
                    + token.type + ' (' + token.content + ')'
                ));
            }
            return next();
        }
        else if (waiting && waiting.name === 'import id') {
            if (token.type === 'identifier') {
                var name = waiting.exports[token.content];
                if (!name) {
                    return emit('error', new Error(
                        'unresolved import: ' + token.content
                    ));
                }
                this.push(waiting.exports[token.content]);
                waiting = null;
            }
            else {
                return emit('error', new Error(
                    'unexpected token: ' + token.type
                    + '. expected: identifier'
                ));
            }
            return next();
        }
        
        if (matching) {
            var m = matching.states[matching.index ++];
            if (m.type !== token.type) {
                if (m.optional) {
                    matching.index = matching.states.length - 1;
                    this.push(src);
                }
                else return emit('error', new Error(
                    'unexpected type: ' + m.type 
                    + '. expected: ' + token.type
                ));
            }
            else if (m.content && m.content !== token.content) {
                if (m.optional) {
                    matching.index = matching.states.length - 1;
                    this.push(src);
                }
                else return emit('error', new Error(
                    'unexpected content: ' + JSON.stringify(token.content)
                    + '. expected: ' + JSON.stringify(m.content)
                ));
            }
            else matching.tokens.push(token);
            
            var f = matching.states[matching.index];
            if (typeof f === 'function') {
                f(matching.tokens, next);
                matching.index = 0;
                matching.tokens = [];
                matching = null;
                return;
            }
            else next();
        }
        else if (token.type === 'identifier' && required[token.content]) {
            var nsp = required[token.content];
            var ex = exported[nsp];
             
            if (!ex) return emit('error', new Error(
                'unknown export ' + token.content
            ));
            if (ex['=']) {
                this.push('(' + nsp + '::' + ex['='] + ')');
            }
            else {
                this.push(nsp + '::');
                waiting = { name: 'exported', exports: exported[nsp] };
            }
            next();
        }
        else {
            for (var i = 0; i < states.length; i++) {
                var s = states[i].states[0];
                if (token.type === s.type
                && (!s.content || s.content === token.content)) {
                    matching = states[i];
                    matching.tokens.push(token);
                    matching.index ++;
                    return next();
                }
            }
            this.push(src);
            next();
        }
    };
    
    t.on('error', function (err) { emit('error', err) });
    
    var combined = combine(t, tr);
    combined.namespace = ns;
    return combined;
    
    function emit () {
        combined.emit.apply(combined, arguments);
    }
};