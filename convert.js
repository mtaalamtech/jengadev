const sharp = require('sharp');
const { execSync } = require('child_process');

sharp('dashboard/logo.png').resize(256, 256).toFile('logo_real.png').then(() => {
    console.log('Saved real png');
    execSync('png-to-ico logo_real.png > JengaDev.ico', {stdio: 'inherit'});
    console.log('Done converting to ICO');
}).catch(console.error);
