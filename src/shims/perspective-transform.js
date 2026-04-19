// ES module shim: runs the perspective-transform UMD factory directly,
// bypassing the `this`-as-global pattern that fails in strict ES modules.

// Inline numeric shim (extracted from perspective-transform's bundled copy)
const numeric = {};
numeric.dim = function dim(x) { var y,z; if(typeof x==='object'){y=x[0];if(typeof y==='object'){z=y[0];if(typeof z==='object'){return numeric._dim(x);}return[x.length,y.length];}return[x.length];}return[];};
numeric._dim = function _dim(x) { var ret=[],z=x;while(typeof z==='object'){ret.push(z.length);z=z[0];}return ret;};
numeric.isNumber = function(x){return typeof x==='number';};
numeric.tensor = function tensor(x,y){if(typeof x==='number'&&typeof y==='number')return x*y;var p=numeric.dim(x),q=numeric.dim(y),m=p[0],n=q[1],ret=numeric.rep([m,n],0),Ai,i,j;for(i=0;i<m;i++){Ai=x[i];ret[i]=[];for(j=0;j<n;j++)ret[i][j]=Ai*y[j];}return ret;};
numeric.rep = function rep(s,v,k){if(typeof k==='undefined'){k=0;}var n=s[k],ret=Array(n),i;if(k===s.length-1){for(i=n-1;i>=0;i--)ret[i]=v;return ret;}for(i=n-1;i>=0;i--)ret[i]=numeric.rep(s,v,k+1);return ret;};
numeric.dotMMsmall = function dotMMsmall(x,y){var i,j,k,p,q,r,ret,foo,bar,woo,i0;p=x.length;q=y.length;r=y[0].length;ret=Array(p);for(i=p-1;i>=0;i--){foo=Array(r);bar=x[i];for(k=r-1;k>=0;k--){woo=bar[0]*y[0][k];for(j=1;j<q;j++)woo+=bar[j]*y[j][k];foo[k]=woo;}ret[i]=foo;}return ret;};
numeric.dotMV = function dotMV(x,y){var p=x.length,i;var ret=Array(p);for(i=p-1;i>=0;i--)ret[i]=numeric.dot(x[i],y);return ret;};
numeric.dot = function dot(x,y){var k=numeric.dim(x).length;if(k===2){if(numeric.dim(y).length===1)return numeric.dotMV(x,y);return numeric.dotMMsmall(x,y);}if(typeof x==='number')return numeric.mul(x,y);return numeric.dotVV(x,y);};
numeric.dotVV = function dotVV(x,y){var i,n=x.length,ret=x[0]*y[0];for(i=1;i<n;i++)ret+=x[i]*y[i];return ret;};
numeric.transpose = function transpose(x){var i,j,m=x.length,n=x[0].length,ret=Array(n),A;for(i=0;i<n;i++){A=Array(m);for(j=m-1;j>=0;j--)A[j]=x[j][i];ret[i]=A;}return ret;};
numeric.inv = function inv(x){var s=numeric.dim(x),abs=Math.abs,m=s[0],n=s[1];var A=numeric.clone(x),Ai,Aj;var I=numeric.identity(m),Ii,Ij;var i,j,k,x2;for(j=0;j<n;j++){var i0=-1,v0=-1;for(i=j;i!==m;++i){k=abs(A[i][j]);if(k>v0){i0=i;v0=k;}}Aj=A[i0];A[i0]=A[j];A[j]=Aj;Ij=I[i0];I[i0]=I[j];I[j]=Ij;x2=Aj[j];for(k=j;k!==n;++k)Aj[k]/=x2;for(k=m-1;k!==m;++k)Ij[k]/=x2;for(i=m-1;i!==-1;--i){Ai=A[i];Ii=I[i];if(i!==j){x2=Ai[j];for(k=j+1;k!==n;++k)Ai[k]-=Aj[k]*x2;for(k=m-1;k!==-1;--k)Ii[k]-=Ij[k]*x2;Ai[j]=0;}}}return I;};
numeric.identity = function identity(n){return numeric.diag(numeric.rep([n],1));};
numeric.diag = function diag(d){var i,i1,j,n=d.length,A=Array(n),Ai;for(i=n-1;i>=0;i--){Ai=Array(n);for(j=n-1;j>=1;j--)Ai[j]=0;i1=i-1;for(j=i1;j>=0;j--)Ai[j]=0;Ai[i]=d[i];A[i]=Ai;}return A;};
numeric.clone = function clone(x){if(typeof x!=='object')return x;var V=Array(x.length);for(var i=x.length-1;i>=0;i--)V[i]=numeric.clone(x[i]);return V;};

function round(num){ return Math.round(num*10000000000)/10000000000; }

function getNormalizationCoefficients(srcPts, dstPts, isInverse){
  if(isInverse){ var tmp=dstPts; dstPts=srcPts; srcPts=tmp; }
  var r1=[srcPts[0],srcPts[1],1,0,0,0,-1*dstPts[0]*srcPts[0],-1*dstPts[0]*srcPts[1]];
  var r2=[0,0,0,srcPts[0],srcPts[1],1,-1*dstPts[1]*srcPts[0],-1*dstPts[1]*srcPts[1]];
  var r3=[srcPts[2],srcPts[3],1,0,0,0,-1*dstPts[2]*srcPts[2],-1*dstPts[2]*srcPts[3]];
  var r4=[0,0,0,srcPts[2],srcPts[3],1,-1*dstPts[3]*srcPts[2],-1*dstPts[3]*srcPts[3]];
  var r5=[srcPts[4],srcPts[5],1,0,0,0,-1*dstPts[4]*srcPts[4],-1*dstPts[4]*srcPts[5]];
  var r6=[0,0,0,srcPts[4],srcPts[5],1,-1*dstPts[5]*srcPts[4],-1*dstPts[5]*srcPts[5]];
  var r7=[srcPts[6],srcPts[7],1,0,0,0,-1*dstPts[6]*srcPts[6],-1*dstPts[6]*srcPts[7]];
  var r8=[0,0,0,srcPts[6],srcPts[7],1,-1*dstPts[7]*srcPts[6],-1*dstPts[7]*srcPts[7]];
  var matA=[r1,r2,r3,r4,r5,r6,r7,r8], matB=dstPts, matC;
  try{ matC=numeric.inv(numeric.dotMMsmall(numeric.transpose(matA),matA)); }
  catch(e){ console.log(e); return [1,0,0,0,1,0,0,0]; }
  var matD=numeric.dotMMsmall(matC,numeric.transpose(matA));
  var matX=numeric.dotMV(matD,matB);
  for(var i=0;i<matX.length;i++) matX[i]=round(matX[i]);
  matX[8]=1;
  return matX;
}

function PerspT(srcPts, dstPts){
  if((typeof window!=='undefined'&&window===this)||this===undefined) return new PerspT(srcPts,dstPts);
  this.srcPts=srcPts; this.dstPts=dstPts;
  this.coeffs=getNormalizationCoefficients(srcPts,dstPts,false);
  this.coeffsInv=getNormalizationCoefficients(srcPts,dstPts,true);
  return this;
}
PerspT.prototype = {
  transform: function(x,y){ return [(this.coeffs[0]*x+this.coeffs[1]*y+this.coeffs[2])/(this.coeffs[6]*x+this.coeffs[7]*y+1),(this.coeffs[3]*x+this.coeffs[4]*y+this.coeffs[5])/(this.coeffs[6]*x+this.coeffs[7]*y+1)]; },
  transformInverse: function(x,y){ return [(this.coeffsInv[0]*x+this.coeffsInv[1]*y+this.coeffsInv[2])/(this.coeffsInv[6]*x+this.coeffsInv[7]*y+1),(this.coeffsInv[3]*x+this.coeffsInv[4]*y+this.coeffsInv[5])/(this.coeffsInv[6]*x+this.coeffsInv[7]*y+1)]; }
};

export default PerspT;
