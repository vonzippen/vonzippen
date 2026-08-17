// Prototype only. Bandsintown and Spotify embeds will be wired in once the official artist/profile URLs are confirmed.
document.querySelectorAll('a[href^="#"]').forEach(link=>{link.addEventListener('click',()=>{document.body.classList.remove('menu-open')})});
