import {copyFileSync,existsSync} from 'node:fs';
for(const [src,dest] of [['andy.example.json','andy.json'],['keys.example.json','keys.json']]) {
 if(!existsSync(dest)){copyFileSync(src,dest);console.log('Created '+dest);}
 else console.log('Preserved '+dest);
}
console.log('Set model/base URL in andy.json and COURSE_API_KEY in keys.json (or environment). Never commit these local files.');
